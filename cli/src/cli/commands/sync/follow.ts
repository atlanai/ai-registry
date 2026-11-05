import { list, plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import type { SettledArtifact } from "#cli/commands/sync/result.ts";
import { failureWords, itemLine } from "#cli/render/run.ts";
import { loadAdapter } from "#core/adapter/load.ts";
import { readOnlyLayout } from "#core/adapter/read-only.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import {
  isFailed,
  isInterrupted,
  RunErrorCode,
  type RunEvent,
  RunEventType,
  type RunRecord,
} from "#core/run/model.ts";
import { scopeFlag } from "#core/store/paths.ts";
import { followRun, type RpcClient } from "#daemon/rpc/client.ts";
import { publishInstead } from "#engine/publish/target.ts";
import type { load } from "#engine/scope/load.ts";

type Loaded = Awaited<ReturnType<typeof load>>;

export async function conflictHint(
  loaded: Loaded,
  names: readonly string[],
  key: string,
  registry: string,
): Promise<string> {
  const short = key.split("/").at(-1) ?? key;
  const first = names.filter((name) => name.split("/").at(-1) === short).length === 1 ? short : key;
  const id = loaded.lock.registries[registry]?.adapter;
  // An adapter that will not load gets the general wording.
  const adapter = id === undefined ? undefined : await loadAdapter(id).catch(() => undefined);
  // Run as printed from anywhere: without `-g` a user scope's conflict is not found.
  const resolve = `aireg sync resolve ${first}${scopeFlag(loaded.roots.scope)}`;
  const theirs = `take the registry's copy with \`${resolve} --theirs\``;
  const ownRegistry = `Take the registry's copy with \`${resolve} --theirs\`, or keep yours by publishing it to a registry of your own, made with \`aireg registry init <folder>\`.`;
  const config = loaded.manifest.registries[registry]?.config ?? {};
  if (readOnlyLayout(registry, config) !== undefined) return ownRegistry;
  if (adapter === undefined || adapter.capabilities.publish) {
    return `Keep yours as a new version with \`${resolve} --mine\`, or ${theirs}.`;
  }
  const namespace = loaded.lock.artifacts[key]?.namespace ?? "<namespace>";
  const instead = publishInstead(adapter, `aireg publish ${first} --to <folder>/${namespace}`);
  return instead === undefined
    ? ownRegistry
    : `Take the registry's copy with \`${resolve} --theirs\`, or keep yours: ${instead}.`;
}

/** What `aireg publish` settles: an edit, or a removal, made here. */
export const PUBLISHED_BY_YOU = ["publish", "archive", "adopt"] as const;
export const PUBLISH_HINT = "Run `aireg publish` to publish what was edited here.";

export interface Followed {
  attention: boolean;
  failed: boolean;
  stopped: string | undefined;
  run: RunRecord;
  artifacts: SettledArtifact[];
  warnings: string[];
}

export function runSummary(
  counts: RunRecord["counts"],
  prefix: string,
  named: string | undefined,
): string {
  const { examined, changed, attention, failed, skipped } = counts;
  if (changed === 0 && attention === 0 && failed === 0 && skipped === 0) {
    return `In sync with ${named ?? "every registry"} (${plural(examined, "artifact")}).`;
  }
  // Skipped: left alone by a policy that is off, or a registry that takes no publishes.
  const parts = [
    changed > 0 ? `${changed} changed` : "",
    attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} attention` : "",
    failed > 0 ? `${failed} failed` : "",
    skipped > 0 ? `${skipped} left as ${skipped === 1 ? "it is" : "they are"}` : "",
  ].filter((part) => part !== "");
  return `${prefix}Checked ${plural(examined, "artifact")}: ${list(parts)}.`;
}

export async function follow(
  context: CommandContext,
  client: RpcClient,
  runId: string,
  /** Named on the summary line only when the scope declares several registries. */
  label: string | undefined,
  /** The registry the run was limited to, if one was named. */
  named: string | undefined,
): Promise<Followed> {
  let attention = false;
  let failed = false;
  const artifacts: Followed["artifacts"] = [];
  const warnings: string[] = [];

  await followRun(client, runId, (event) => {
    if (event.eventType === RunEventType.Warning) {
      const { message, hint } = (event.data ?? {}) as { message?: unknown; hint?: unknown };
      if (typeof message !== "string") return;
      warnings.push(message);
      context.printer.warning(message);
      if (typeof hint === "string") context.printer.hint(hint);
      return;
    }
    if (event.artifact === undefined || event.eventType !== RunEventType.ItemSettled) return;
    if (event.outcome === "unchanged" || event.outcome === "skipped") return;
    context.printer.info(itemLine(context.printer, event));
    artifacts.push(settledOf(event.artifact, event));
    if (event.outcome === "attention") attention = true;
    if (event.outcome === "failed") failed = true;
  });

  const { run } = await client.request("run.get", { runId });
  const prefix = label === undefined ? "" : `${label}: `;
  // It checked only part of the scope, so its counts must not read as in sync.
  const stopped = isInterrupted(run.state)
    ? failureWords(run.errorCode ?? RunErrorCode.Canceled)
    : undefined;
  if (stopped === undefined) {
    context.printer.info(context.printer.style.dim(runSummary(run.counts, prefix, label ?? named)));
  }
  if (isFailed(run.state)) failed = true;
  if (run.counts.attention > 0 || run.state === "attention" || run.state === "partial") {
    attention = true;
  }
  return { attention, failed, stopped, run, artifacts, warnings };
}

function settledOf(name: string, event: RunEvent): SettledArtifact {
  return {
    name,
    ...(event.kind === undefined ? {} : { kind: event.kind }),
    outcome: event.outcome ?? "changed",
    ...(event.operation === undefined ? {} : { operation: event.operation }),
    ...(event.disposition === undefined ? {} : { disposition: event.disposition }),
  };
}

export interface StoppedRun {
  name: string;
  reason: string;
}

export function stoppedError(
  what: string,
  stopped: readonly StoppedRun[],
  again: string,
): AiregError {
  const [only] = stopped;
  const why =
    stopped.length === 1 && only !== undefined
      ? `${only.name}: ${only.reason}`
      : list(stopped.map(({ name, reason }) => `${name} (${reason})`));
  return new AiregError(`${what} ${why}.`, {
    code: ErrorCode.Unavailable,
    hint: `Run \`${again}\` again.`,
  });
}

export async function attentionHints(
  context: CommandContext,
  loaded: Loaded,
  waiting: readonly { registry: string; name: string; disposition: string | undefined }[],
): Promise<void> {
  const conflict = waiting.find((item) => item.disposition === "conflict");
  if (conflict !== undefined) {
    const names = Object.keys(loaded.lock.artifacts);
    context.printer.hint(await conflictHint(loaded, names, conflict.name, conflict.registry));
  }
  const yours: readonly string[] = PUBLISHED_BY_YOU;
  if (waiting.some((item) => yours.includes(item.disposition ?? ""))) {
    context.printer.hint(PUBLISH_HINT);
  }
  const other = waiting.some(
    (item) => item.disposition !== "conflict" && !yours.includes(item.disposition ?? ""),
  );
  if (other || waiting.length === 0) {
    context.printer.hint("Run `aireg sync --dry-run` to see what each one needs.");
  }
}
