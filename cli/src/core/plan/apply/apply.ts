import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fanOut } from "#core/fs/link.ts";
import { entries, remove } from "#core/fs/tree.ts";
import { assertLeasesHeld } from "#core/lease/lease.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { carriedBy } from "#core/plan/carries.ts";
import type { Action, Fetch, Plan } from "#core/plan/model.ts";
import { assertRemovable } from "#core/plan/removable.ts";
import { ensureScopeIgnore } from "#core/store/ignore.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { PROJECTIONS_DIR, type Roots } from "#core/store/paths.ts";
import { assemble } from "./assemble.ts";
import { journal } from "./journal.ts";
import { linkInto, preflight, unlink } from "./link.ts";
import { record } from "./record.ts";
import { applyRegistrations } from "./registrations.ts";
import type { ApplyResult, Run } from "./run.ts";
import { cloneInto, prefetch, stage } from "./stage.ts";

const linked = (lock: Lock | undefined, name: string): number =>
  lock?.artifacts[name]?.links.length ?? 0;

export async function apply(
  plan: Plan,
  roots: Roots,
  fetch: Fetch,
  onStep?: (action: Action) => void,
): Promise<ApplyResult> {
  const guards = await preflight(plan, roots);
  const before = await readLock(roots);
  await journal(plan, roots, guards);
  const run: Run = {
    roots,
    ahead: prefetch(plan, fetch),
    guards,
    stamp: undefined,
    digests: new Map(),
    materialized: new Map(),
    measured: new Set(),
    upstream: new Map(),
    modes: new Map(),
    pathModes: new Map(),
    copies: new Map(),
    degraded: new Set(),
    plugins: new Map(),
    fanned: new Map(),
    copiedPlugins: new Map(),
    skipped: new Set(),
    unstaged: new Map(),
    performed: { stage: 0, clone: 0, link: 0, unlink: 0 },
    installed: new Set(),
    kept: [],
    adopted: [],
    backedUp: [],
    recorded: undefined,
    before,
    projections: undefined,
    unrendered: [],
  };

  let leaseCheckedAt = 0;
  for (const action of plan.actions) {
    // Reading the lease per action is a file read each; the lock write checks it again regardless.
    if (action.kind === "record" || Date.now() - leaseCheckedAt >= LEASE_CHECK_MS) {
      await assertLeasesHeld();
      leaseCheckedAt = Date.now();
    }
    onStep?.(action);
    if (action.kind !== "record")
      await guardManagedPath(action.to, roots, action.kind !== "unlink");
    await perform(run, action);
  }
  await finish(run, plan);

  await rm(roots.applyJournal, { force: true });
  return {
    performed: run.performed,
    installed: [...run.installed].sort(),
    added: Object.keys(run.recorded?.artifacts ?? {})
      .filter((name) => linked(before, name) === 0)
      .sort(),
    removed:
      run.recorded === undefined
        ? []
        : Object.keys(before?.artifacts ?? {})
            .filter((name) => linked(before, name) > 0 && linked(run.recorded, name) === 0)
            .sort(),
    lock: run.recorded,
    degraded: [...run.degraded].sort(),
    unstaged: [...run.unstaged].map(([name, { reason, error }]) => ({ name, reason, error })),
    kept: run.kept,
    adopted: run.adopted,
    backedUp: run.backedUp,
    carried: await carriedBy(plan, run.recorded, roots),
    unrendered: run.unrendered,
  };
}

/** How stale a run's knowledge that it still holds the lease may be. */
const LEASE_CHECK_MS = 250;

function perform(run: Run, action: Action): Promise<void> {
  switch (action.kind) {
    case "stage":
      return stage(run, action);
    case "clone":
      return cloneInto(run, action);
    case "link":
      return linkInto(run, action);
    case "unlink":
      return unlink(run, action);
    case "record":
      return record(run, action);
  }
}

/** Work that needs every clone landed first, then the store's housekeeping. */
async function finish(run: Run, plan: Plan): Promise<void> {
  const { roots } = run;
  // At link time a projection would see only the kind whose artifact happened to be first.
  for (const [dir, { content, targets, document }] of run.plugins) {
    await guardManagedPath(dir, roots);
    await assemble(dir, content, targets, document);
  }
  for (const [to, from] of run.fanned) {
    await assertRemovable(to, roots);
    await fanOut(from, to);
  }
  if (run.projections !== undefined) await pruneProjections(run.projections, roots);
  if (run.plugins.size > 0 || Object.values(run.performed).some((count) => count > 0)) {
    await guardManagedPath(roots.artifacts, roots);
    await ensureScopeIgnore(roots);
  }
  run.kept.push(...(await applyRegistrations(plan.actions, roots, run.recorded ?? run.before)));
}

/** A link assembles a namespace's projection and no unlink takes it, so it goes with its last row. */
async function pruneProjections(wanted: ReadonlySet<string>, roots: Roots): Promise<void> {
  const root = join(roots.artifacts, PROJECTIONS_DIR);
  await guardManagedPath(root, roots);
  for (const { name: source } of await entries(root)) {
    await guardManagedPath(join(root, source), roots);
    for (const { name: plugin } of await entries(join(root, source))) {
      const path = join(root, source, plugin);
      await guardManagedPath(path, roots);
      if (!wanted.has(path)) await remove(path);
    }
    await rmdir(join(root, source)).catch(() => undefined);
  }
  await rmdir(root).catch(() => undefined);
}
