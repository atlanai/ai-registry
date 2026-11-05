import { credentialsForManifest } from "#accounts/credentials.ts";
import { list, quoted } from "#adapter/text.ts";
import {
  attentionHints,
  conflictHint,
  type Followed,
  follow,
  PUBLISH_HINT,
  PUBLISHED_BY_YOU,
  type StoppedRun,
  stoppedError,
} from "#cli/commands/sync/follow.ts";
import { renderSync } from "#cli/commands/sync/render.ts";
import { SYNC_COMMAND } from "#cli/commands/sync/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { isStepPolicy, STEP_POLICIES } from "#core/config/model.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import type { RunRecord } from "#core/run/model.ts";
import { scopeName } from "#core/store/paths.ts";
import { type Candidate, displayPath } from "#core/sync/adopt.ts";
import { UNSETTLED } from "#core/sync/model.ts";
import { POLICY_AXES, type PolicyAxis, type SyncPolicy } from "#core/sync/policy.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { shadowedByYours, surveyClaims } from "#engine/sync/claim.ts";
import { closeScan, scan } from "#engine/sync/scan.ts";
import { FOREGROUND_POLICY } from "#engine/sync/work.ts";
import type { CommandContext } from "./command.ts";

type Own = Record<string, unknown> & Partial<Record<PolicyAxis, string>>;

/**
 * Reconciles this scope with its registries, under a policy that pulls but
 * never publishes unasked. `--dry-run` reports without writing.
 */
export async function run(context: CommandContext): Promise<void> {
  // Dispatched before parsing: `parse` is strict and knows only the common
  // options, so it would reject resolve's own flags such as `--mine`.
  if (context.argv[0] === "resolve") {
    const { run: settle } = await import("#cli/commands/sync/resolve.ts");
    return settle({ ...context, argv: context.argv.slice(1) });
  }

  const { common, positionals, own } = parse<Own>(context.argv, SYNC_COMMAND);
  const policy = policyFrom(own);

  if (common.dryRun) return report(context, common, policy, positionals[0]);
  return reconcile(context, common, policy, positionals[0]);
}

type Scanned = Awaited<ReturnType<typeof scan>>;
type Loaded = Awaited<ReturnType<typeof load>>;

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

/** `--dry-run`: scans the registries a sync would cover and reports what it would do. */
async function report(
  context: CommandContext,
  common: CommonOptions,
  policy: SyncPolicy,
  only: string | undefined,
): Promise<void> {
  const loaded = await load(common, context.cwd);
  const wanted = covered(loaded, only);
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
    await print(context, loaded, scoped, policy, only);
  } finally {
    await closeScan(found);
  }
}

/** The registries a run covers: the one named, or every one the scope declares. */
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

/** What `--dry-run` prints of one scan. */
async function print(
  context: CommandContext,
  loaded: Loaded,
  found: Scanned,
  policy: SyncPolicy,
  only: string | undefined,
): Promise<void> {
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

  if (context.printer.format === "json") {
    const place = (item: Candidate) => ({
      name: item.name,
      kind: item.kind,
      path: displayPath(loaded.roots, item.from),
      target: item.target,
    });
    context.printer.json({
      ok: true,
      data: {
        dryRun: true,
        scope: loaded.roots.scope,
        artifacts: shown.map(({ source, ...item }) => ({ ...item, registry: source })),
        local: local.map((item) => ({ ...place(item), suggestedPath: item.suggestedPath })),
        undeclared: undeclared.map(place),
        linkable: claiming ? linkable.map(place) : [],
        changed: claiming ? changed.map(place) : [],
        kept: kept.map(place),
      },
    });
  } else {
    renderSync(
      context.printer,
      shown,
      local,
      undeclared,
      loaded.roots,
      claiming ? { linkable, changed, kept: [] } : { linkable: [], changed: [], kept },
      only,
    );
    await nextSteps(context, loaded, found, undeclared);
  }

  const unsettled =
    items.some((item) => UNSETTLED.includes(item.disposition)) ||
    local.length > 0 ||
    found.undeclared.length > 0;
  if (unsettled) context.exit = ExitCode.Changed;
}

/**
 * A copy of what a registry this scope installs publishes is linked by the
 * next sync when its bytes match, and held when someone changed it.
 */
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
  context: CommandContext,
  loaded: Loaded,
  found: Scanned,
  undeclared: Candidate[],
): Promise<void> {
  const { items, local, publisher } = found;
  const has = (...dispositions: string[]) =>
    items.some((item) => dispositions.includes(item.disposition));
  if (has("pull", "pull-delete")) {
    context.printer.hint("Run `aireg sync` to take the registry's changes.");
  }
  const conflict = items.find((item) => item.disposition === "conflict");
  if (conflict !== undefined) {
    const names = items.map((item) => item.name);
    context.printer.hint(await conflictHint(loaded, names, conflict.name, conflict.source));
  }
  if (has(...PUBLISHED_BY_YOU) || local.length > 0) context.printer.hint(PUBLISH_HINT);
  if (undeclared.length > 0) {
    const names = undeclared
      .map((item) => {
        const alias = publisher.get(`${item.kind}:${item.name}`);
        return alias === undefined ? item.name : `${alias}/${item.name}`;
      })
      .join(" ");
    context.printer.hint(`Run \`aireg add ${names}\` to install them from their registry.`);
  }
}

/**
 * Through the daemon rather than in this process: a run belongs in the run store
 * whoever asked for it, so `aireg job runs` shows this one and `--follow` reads it.
 */
async function reconcile(
  context: CommandContext,
  common: CommonOptions,
  policy: SyncPolicy,
  only: string | undefined,
): Promise<void> {
  const loaded = await load(common, context.cwd);
  const wanted = covered(loaded, only);

  let attention = false;
  const failed: string[] = [];
  const stopped: StoppedRun[] = [];
  const runs: (Pick<RunRecord, "id" | "state" | "counts"> & {
    registry: string;
    artifacts: Followed["artifacts"];
    warnings: string[];
  })[] = [];
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

  if (stopped.length > 0) throw stoppedError("Could not finish syncing", stopped, "aireg sync");
  if (failed.length > 0) {
    // The run store keeps only the code; the reason is in the daemon's log.
    throw new AiregError(`Could not sync ${list(failed)}.`, {
      code: ErrorCode.Unavailable,
      hint: "Run `aireg logs --daemon --level warn` to see why.",
    });
  }
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { dryRun: false, scope: loaded.roots.scope, runs } });
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
