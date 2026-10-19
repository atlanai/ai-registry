import { list, plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { publishInstead } from "#cli/publish/target.ts";
import { itemLine } from "#cli/render/run.ts";
import { loadAdapter } from "#core/adapter/registry.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
import { ITEM_EVENT, isFailed, type RunRecord, WARNING_EVENT } from "#core/run/model.ts";
import { followRun, type RpcClient } from "#daemon/rpc/client.ts";
import type { load } from "#engine/pipeline.ts";

type Loaded = Awaited<ReturnType<typeof load>>;

/** How to settle the first conflict, with the short name when it is unambiguous. */
export async function conflictHint(
  loaded: Loaded,
  names: readonly string[],
  key: string,
  registry: string,
): Promise<string> {
  const short = key.split("/").at(-1) ?? key;
  const first = names.filter((name) => name.split("/").at(-1) === short).length === 1 ? short : key;
  const id = loaded.lock.registries[registry]?.adapter;
  const adapter = id === undefined ? undefined : await loadAdapter(id).catch(() => undefined);
  // Run as printed from anywhere: without `-g` a user scope's conflict is not found.
  const resolve = `aireg sync resolve ${first}${loaded.roots.scope === "user" ? " -g" : ""}`;
  const theirs = `take the registry's copy with \`${resolve} --theirs\``;
  const config = loaded.manifest.registries[registry]?.config ?? {};
  if (readOnlyLayout(registry, config) !== undefined) {
    return `Take the registry's copy with \`${resolve} --theirs\`, or keep yours by publishing it to a registry of your own, made with \`aireg registry init <folder>\`.`;
  }
  if (adapter === undefined || adapter.capabilities.publish) {
    return `Keep yours as a new version with \`${resolve} --mine\`, or ${theirs}.`;
  }
  const namespace = loaded.lock.artifacts[key]?.namespace ?? "<namespace>";
  const instead = publishInstead(adapter, `aireg publish ${first} --to <folder>/${namespace}`);
  return `Take the registry's copy with \`${resolve} --theirs\`, or keep yours: ${instead}.`;
}

/** What `aireg publish` settles: an edit, or a removal, made here. */
export const PUBLISHED_BY_YOU = ["publish", "archive", "adopt"] as const;
export const PUBLISH_HINT = "Run `aireg publish` to publish what was edited here.";

export interface Followed {
  attention: boolean;
  failed: boolean;
  run: RunRecord;
  /** Each item that changed, needs you, or failed, as the text lists them. */
  artifacts: {
    name: string;
    kind: string | undefined;
    outcome: string;
    operation?: string;
    disposition?: string;
  }[];
  /** What the run did to your own files, or left undone. */
  warnings: string[];
}

/** One run's result, in the words `--dry-run` uses when there is nothing to do. */
export function runSummary(
  counts: RunRecord["counts"],
  prefix: string,
  named: string | undefined,
): string {
  const { examined, changed, attention, failed, skipped } = counts;
  if (changed === 0 && attention === 0 && failed === 0 && skipped === 0) {
    return `In sync with ${named ?? "every registry"} (${plural(examined, "artifact")}).`;
  }
  const parts = [
    changed > 0 ? `${changed} changed` : "",
    attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} attention` : "",
    failed > 0 ? `${failed} failed` : "",
    // Left alone by a policy that is off, or by a registry that takes no publishes: not in sync.
    skipped > 0 ? `${skipped} left as ${skipped === 1 ? "it is" : "they are"}` : "",
  ].filter((part) => part !== "");
  return `${prefix}Checked ${plural(examined, "artifact")}: ${list(parts)}.`;
}

/** Renders one run's item events in the vocabulary `--dry-run` already uses. */
export async function follow(
  context: CommandContext,
  client: RpcClient,
  runId: string,
  /** The registry, named on its summary line when the scope declares more than one. */
  label: string | undefined,
  /** The registry the run was asked to cover, when one was named. */
  named: string | undefined,
): Promise<Followed> {
  let attention = false;
  let failed = false;
  const artifacts: Followed["artifacts"] = [];
  const warnings: string[] = [];

  await followRun(client, runId, (event) => {
    if (event.eventType === WARNING_EVENT) {
      const { message, hint } = (event.data ?? {}) as { message?: unknown; hint?: unknown };
      if (typeof message !== "string") return;
      warnings.push(message);
      context.printer.warning(message);
      if (typeof hint === "string") context.printer.hint(hint);
      return;
    }
    if (event.artifact === undefined || event.eventType !== ITEM_EVENT) return;
    if (event.outcome === "unchanged" || event.outcome === "skipped") return;
    context.printer.info(itemLine(context.printer, event));
    artifacts.push({
      name: event.artifact,
      kind: event.kind,
      outcome: event.outcome ?? "changed",
      ...(event.operation === undefined ? {} : { operation: event.operation }),
      ...(event.disposition === undefined ? {} : { disposition: event.disposition }),
    });
    if (event.outcome === "attention") attention = true;
    if (event.outcome === "failed") failed = true;
  });

  const { run } = await client.request("run.get", { runId });
  const prefix = label === undefined ? "" : `${label}: `;
  context.printer.info(context.printer.style.dim(runSummary(run.counts, prefix, label ?? named)));
  if (isFailed(run.state)) failed = true;
  if (run.counts.attention > 0 || run.state === "attention" || run.state === "partial") {
    attention = true;
  }
  return { attention, failed, run, artifacts, warnings };
}

/** What to run for what a sync left for you, as `--dry-run` would say it. */
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
