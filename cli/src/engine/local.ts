import { digest } from "#core/fs/digest.ts";
import { exists } from "#core/fs/tree.ts";
import { cloneLock, type Lock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import type { Action, Plan } from "#core/plan/model.ts";
import { movedPluginLinks } from "#core/plan/projection.ts";
import { survey } from "#core/plan/survey.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import type { CommonOptions } from "./options.ts";
import { recordServed } from "./origins.ts";
import {
  type ApplyNotice,
  appliedNotices,
  commit,
  type Loaded,
  prepareWrite,
  recordOf,
  recoveredNotices,
  refuseBlocked,
  refusePlan,
  resolveTargets,
  unstagedNotices,
} from "./pipeline.ts";
import { narrowToRelinks, relinksIn } from "./relink.ts";
import type { Scan } from "./scan.ts";

function mergePlan(plan: Plan, previous: Lock, names: ReadonlySet<string>): Plan {
  const generated = recordOf(plan);
  const next = cloneLock(previous);
  for (const name of names) {
    const artifact = generated.artifacts[name];
    // Absent from the fresh plan means the registry no longer offers it, so
    // the row goes. A name that was never locked has nothing to remove.
    if (artifact === undefined) delete next.artifacts[name];
    else next.artifacts[name] = artifact;
  }
  for (const [alias, source] of Object.entries(generated.registries)) {
    if (Object.values(next.artifacts).some((artifact) => artifact.registry === alias)) {
      next.registries[alias] = source;
    }
  }
  for (const alias of Object.keys(next.registries)) {
    if (!Object.values(next.artifacts).some((artifact) => artifact.registry === alias)) {
      delete next.registries[alias];
    }
  }
  return {
    actions: plan.actions
      .filter((action) => action.kind !== "record" && names.has(action.name))
      .concat({ kind: "record", lock: next }),
    unchanged: plan.unchanged.filter((name) => names.has(name)),
    warnings: plan.warnings,
    incompatible: plan.incompatible,
    rewritten: plan.rewritten,
    clashes: plan.clashes,
    renamed: plan.renamed,
    neededBy: plan.neededBy,
    pruned: plan.pruned.filter((name) => names.has(name)),
    unresolved: plan.unresolved,
    conflicts: plan.conflicts,
    withheld: plan.withheld.filter((item) => names.has(item.name)),
  };
}

/**
 * A publish sends this scope's copy, so what landed upstream is exactly what is
 * on disk; the row's digest is restated from it rather than from a refetch.
 */
async function preservePublishedDigests(
  plan: Plan,
  scan: Scan,
  published: ReadonlySet<string>,
): Promise<void> {
  const lock = recordOf(plan);
  for (const name of published) {
    const entry = lock.artifacts[name];
    if (entry === undefined) continue;
    const copy = artifactPath(
      scan.roots,
      entry.registry,
      entry.namespace,
      entry.kind,
      copyLeaf(name, entry.name),
      entry.address ?? "",
    );
    if (await exists(copy)) entry.digest = await digest(copy);
  }
}

export async function applyLocal(
  loaded: Loaded,
  common: CommonOptions,
  scan: Scan,
  names: ReadonlySet<string>,
  published: ReadonlySet<string>,
  /** Restages a locally edited artifact, which otherwise only warns. */
  force: boolean,
  onStep: (action: Action) => void,
): Promise<{ changed: number; notices: ApplyNotice[] }> {
  // A run that only published still has something to record, or the lock never
  // learns what this project sent and every later comparison has no base.
  const recording = new Set([...names, ...published]);
  const opened = new Set(scan.acquired.map((source) => source.alias));
  const moved = movedPluginLinks(loaded.lock, loaded, opened);
  const relinks = relinksIn(moved, recording);
  if (recording.size === 0 && relinks.size === 0) return { changed: 0, notices: [] };
  // The caller holds the lease: it has to cover the publish that precedes this.
  const notices = recoveredNotices(loaded.roots, await prepareWrite(loaded));
  const targets = resolveTargets(loaded.manifest, loaded.harnesses, common);
  const plan = build(
    loaded.manifest,
    scan.pinned,
    scan.acquired,
    await survey(scan.pinned, loaded.roots),
    {
      roots: loaded.roots,
      targets,
      harnesses: loaded.harnesses,
      force,
      copy: false,
      cliVersion: VERSION,
    },
  );
  refusePlan(plan, scan.acquired, loaded.lock);
  await preservePublishedDigests(plan, scan, published);
  recordServed(recordOf(plan), scan, recording);
  // The lock as it stands, not as the scan found it: a folder step writes its
  // own rows inside this run, and the plan must not reclaim them.
  const narrowed = narrowToRelinks(
    mergePlan(plan, loaded.lock, new Set([...recording, ...relinks])),
    relinks,
  );
  await refuseBlocked(narrowed);
  const result = await commit(loaded, narrowed, scan.acquired, targets, onStep);
  notices.push(
    ...appliedNotices(loaded.roots, result, loaded.harnesses),
    ...unstagedNotices(result.unstaged),
  );
  return {
    changed: Object.values(result.performed).reduce((sum, count) => sum + count, 0),
    notices,
  };
}
