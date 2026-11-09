import { credentialsForManifest } from "#accounts/credentials.ts";
import { list, quoted } from "#adapter/text.ts";
import {
  attentionHints,
  conflictHint,
  follow,
  PUBLISH_HINT,
  PUBLISHED_BY_YOU,
  type StoppedRun,
  stoppedError,
} from "#cli/commands/sync/follow.ts";
import { renderSync } from "#cli/commands/sync/render.ts";
import type { SyncPreview, SyncRuns } from "#cli/commands/sync/result.ts";
import { SYNC_COMMAND } from "#cli/commands/sync/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { trackSync } from "#cli/telemetry/events.ts";
import { isStepPolicy, STEP_POLICIES } from "#core/config/model.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { kindSpec } from "#core/kinds.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import { type Roots, scopeName } from "#core/store/paths.ts";
import { type Candidate, displayPath } from "#core/sync/adopt.ts";
import { type SyncItem, UNSETTLED } from "#core/sync/model.ts";
import { POLICY_AXES, type PolicyAxis, type SyncPolicy } from "#core/sync/policy.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { shadowedByYours, surveyClaims } from "#engine/sync/claim.ts";
import { closeScan, scan } from "#engine/sync/scan.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import type { CommandContext } from "./command.ts";
import { defineCommand, STREAMED } from "./define.ts";

type Own = Record<string, unknown> & Partial<Record<PolicyAxis, string>>;

interface Options {
  common: CommonOptions;
  policy: SyncPolicy;
  only: string | undefined;
}

type Scanned = Awaited<ReturnType<typeof scan>>;
type Loaded = Awaited<ReturnType<typeof load>>;

interface Preview {
  data: SyncPreview;
  shown: SyncItem[];
  local: Candidate[];
  undeclared: Candidate[];
  roots: Roots;
  claims: { linkable: Candidate[]; changed: Candidate[]; kept: Candidate[] };
  next: string[];
}

/** Reconciles this scope with its registries; pulls, but never publishes unasked. */
export async function run(context: CommandContext): Promise<void> {
  // Dispatched before parsing: `parse` is strict and knows only the common
  // options, so it would reject resolve's own flags such as `--mine`.
  if (context.argv[0] === "resolve") {
    const { run: settle } = await import("#cli/commands/sync/resolve.ts");
    return settle({ ...context, argv: context.argv.slice(1) });
  }
  return sync.run(context);
}

const sync = defineCommand({
  spec: SYNC_COMMAND,
  parse(argv): Options {
    const { common, positionals, own } = parse<Own>(argv, SYNC_COMMAND);
    return { common, policy: policyFrom(own), only: positionals[0] };
  },
  // A sync prints each item as the daemon settles it, and its data once every run ends.
  async run(options, context): Promise<Preview | typeof STREAMED> {
    if (options.common.dryRun) return report(context, options);
    await reconcile(context, options);
    return STREAMED;
  },
  data: (result) => result.data,
  text(result, printer, { only }) {
    renderSync(printer, {
      items: result.shown,
      found: result.local,
      undeclared: result.undeclared,
      roots: result.roots,
      claims: result.claims,
      registry: only,
    });
    for (const hint of result.next) printer.hint(hint);
  },
});

/** Flags override the policy one axis at a time, so the others keep their guarantee. */
function policyFrom(own: Own): SyncPolicy {
  const policy = { ...FOREGROUND_POLICY };
  for (const axis of POLICY_AXES) {
    const value = own[axis];
    if (value === undefined) continue;
    if (!isStepPolicy(value)) {
      throw new AiregError(`Unknown --${axis} value ${quoted(value)}.`, {
        code: ErrorCode.Usage,
        hint: `Pass ${list(STEP_POLICIES, "or")}.`,
      });
    }
    policy[axis] = value;
  }
  return policy;
}

async function report(
  context: CommandContext,
  { common, policy, only }: Options,
): Promise<Preview> {
  const loaded = await load(common, context.cwd);
  const wanted = covered(loaded, only);
  for (const [name, row] of Object.entries(loaded.lock.artifacts)) {
    if (!wanted.includes(row.registry) || kindSpec(row.kind) !== undefined) continue;
    context.printer.warning(
      `Left ${quoted(name)} as it is: no loaded adapter declares its kind, ${quoted(row.kind)}.`,
    );
  }
  const found = await scan(loaded, common, {
    ...(only === undefined ? {} : { aliases: wanted }),
    onStep: (message) => context.printer.step(message),
    credentials: await credentialsForManifest(
      loaded.manifest.registries,
      context.cwd,
      undefined,
      wanted,
    ),
  });
  // The lock's rows from the registries left closed are not this run's to report.
  const scoped =
    only === undefined
      ? found
      : { ...found, items: found.items.filter((item) => item.source === only) };
  try {
    return await preview(context, loaded, scoped, policy);
  } finally {
    await closeScan(found);
  }
}

function covered(loaded: Loaded, only: string | undefined): string[] {
  const declared = Object.keys(loaded.manifest.registries).sort();
  const wanted = only === undefined ? declared : declared.filter((alias) => alias === only);
  if (wanted.length > 0) return wanted;
  if (only !== undefined) throw unknownRegistry(only, loaded.roots.scope, declared);
  throw new AiregError(`No registry is declared in ${scopeName(loaded.roots.scope)}.`, {
    code: ErrorCode.Usage,
    hint: "Run `aireg registry add <address>` to declare one.",
  });
}

async function preview(
  context: CommandContext,
  loaded: Loaded,
  found: Scanned,
  policy: SyncPolicy,
): Promise<Preview> {
  const { items, local } = found;
  const { linkable, changed } = await claimable(found);
  const undeclared = found.undeclared.filter(
    (item) => !linkable.includes(item) && !changed.includes(item),
  );
  // Without claiming, those folders stay and the registry copies stay out.
  const claiming = policy.claim === "on";
  const kept = claiming ? [] : [...linkable, ...changed];
  const shadowed = claiming ? new Set<string>() : shadowedByYours(found);
  const shown = items.filter((item) => !shadowed.has(item.name));
  const place = (item: Candidate) => ({
    name: item.name,
    kind: item.kind,
    path: displayPath(loaded.roots, item.from),
    target: item.target,
  });

  const unsettled =
    items.some((item) => UNSETTLED.includes(item.disposition)) ||
    local.length > 0 ||
    found.undeclared.length > 0;
  if (unsettled) context.exit = ExitCode.Changed;
  return {
    data: {
      dryRun: true,
      scope: loaded.roots.scope,
      artifacts: shown.map(previewItem),
      local: local.map((item) => ({ ...place(item), suggestedPath: item.suggestedPath })),
      undeclared: undeclared.map(place),
      linkable: claiming ? linkable.map(place) : [],
      changed: claiming ? changed.map(place) : [],
      kept: kept.map(place),
    },
    shown,
    local,
    undeclared,
    roots: loaded.roots,
    claims: claiming ? { linkable, changed, kept: [] } : { linkable: [], changed: [], kept },
    next: await nextSteps(loaded, found, undeclared),
  };
}

/** An item as JSON carries it: in the scan's key order, with each unset field left out. */
function previewItem(item: SyncItem): SyncPreview["artifacts"][number] {
  const { base, local, upstream } = item.digests;
  return {
    name: item.name,
    kind: item.kind,
    path: item.path,
    disposition: item.disposition,
    digests: {
      ...(base === undefined ? {} : { base }),
      ...(local === undefined ? {} : { local }),
      ...(upstream === undefined ? {} : { upstream }),
    },
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.failure === undefined ? {} : { failure: item.failure }),
    registry: item.source,
  };
}

/** Copies whose bytes match are linked next sync; changed ones are held. */
async function claimable(found: Scanned): Promise<{ linkable: Candidate[]; changed: Candidate[] }> {
  const linkable: Candidate[] = [];
  const changed: Candidate[] = [];
  for (const source of found.acquired) {
    const theirs = found.undeclared.filter(
      (item) => found.publisher.get(`${item.kind}:${item.name}`) === source.alias,
    );
    for (const claim of await surveyClaims(theirs, found.acquired, source.alias)) {
      const item = theirs.find((each) => each.kind === claim.kind && each.name === claim.name);
      if (item === undefined) continue;
      if (claim.different.length > 0) changed.push(item);
      else linkable.push(item);
    }
  }
  return { linkable, changed };
}

async function nextSteps(
  loaded: Loaded,
  found: Scanned,
  undeclared: Candidate[],
): Promise<string[]> {
  const { items, local, publisher } = found;
  const next: string[] = [];
  const has = (...dispositions: string[]) =>
    items.some((item) => dispositions.includes(item.disposition));
  if (has("pull", "pull-delete")) next.push("Run `aireg sync` to take the registry's changes.");
  const conflict = items.find((item) => item.disposition === "conflict");
  if (conflict !== undefined) {
    const names = items.map((item) => item.name);
    next.push(await conflictHint(loaded, names, conflict.name, conflict.source));
  }
  if (has(...PUBLISHED_BY_YOU) || local.length > 0) next.push(PUBLISH_HINT);
  if (undeclared.length > 0) {
    const names = undeclared
      .map((item) => {
        const alias = publisher.get(`${item.kind}:${item.name}`);
        return alias === undefined ? item.name : `${alias}/${item.name}`;
      })
      .join(" ");
    next.push(`Run \`aireg add ${names}\` to install them from their registry.`);
  }
  return next;
}

/**
 * Through the daemon, not in this process: every run belongs in the run store,
 * so `aireg job runs` shows it and `--follow` reads it.
 */
async function reconcile(
  context: CommandContext,
  { common, policy, only }: Options,
): Promise<void> {
  const loaded = await load(common, context.cwd);
  const wanted = covered(loaded, only);
  for (const [name, row] of Object.entries(loaded.lock.artifacts)) {
    if (!wanted.includes(row.registry) || kindSpec(row.kind) !== undefined) continue;
    context.printer.warning(
      `Left ${quoted(name)} as it is: no loaded adapter declares its kind, ${quoted(row.kind)}.`,
    );
  }

  let attention = false;
  const failed: string[] = [];
  const stopped: StoppedRun[] = [];
  const runs: SyncRuns["runs"] = [];
  await withDaemon(async (client) => {
    for (const registry of wanted) {
      if (wanted.length > 1) context.printer.step(`Syncing ${registry}`);
      const token = registryToken(registry);
      const { run } = await client.request("sync.start", {
        root: loaded.roots.cwd,
        scope: loaded.roots.scope,
        registry,
        policy,
        ...(token === undefined ? {} : { token }),
        ...(common.select?.includes("*") === true || common.select === undefined
          ? {}
          : { refs: common.select }),
      });
      const outcome = await follow(
        context,
        client,
        run.id,
        wanted.length > 1 ? registry : undefined,
        only,
      );
      attention = attention || outcome.attention;
      if (outcome.failed) failed.push(registry);
      if (outcome.stopped !== undefined) {
        stopped.push({ name: registry, reason: outcome.stopped });
      }
      const { id, state, counts } = outcome.run;
      runs.push({
        registry,
        id,
        state,
        counts,
        artifacts: outcome.artifacts,
        warnings: outcome.warnings,
      });
    }
  });
  const changed = runs.reduce((sum, item) => sum + item.counts.changed, 0);
  trackSync(runs.length, changed, failed.length);

  if (stopped.length > 0) throw stoppedError("Could not finish syncing", stopped, "aireg sync");
  if (failed.length > 0) {
    // The run store keeps only the code; the reason is in the daemon's log.
    throw new AiregError(`Could not sync ${list(failed)}.`, {
      code: ErrorCode.Unavailable,
      hint: "Run `aireg logs --daemon --level warn` to see why.",
    });
  }
  if (context.printer.format === "json") {
    const data: SyncRuns = { dryRun: false, scope: loaded.roots.scope, runs };
    context.printer.json({ ok: true, data });
  }
  if (attention) {
    if (context.printer.format !== "json") {
      const waiting = runs.flatMap(({ registry, artifacts }) =>
        artifacts
          .filter((item) => item.outcome === "attention")
          .map((item) => ({ registry, name: item.name, disposition: item.disposition })),
      );
      await attentionHints(context, await load(common, context.cwd), waiting);
    }
    context.exit = ExitCode.Changed;
  }
}
