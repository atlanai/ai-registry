import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fanOut } from "#core/fs/link.ts";
import { entries, remove } from "#core/fs/tree.ts";
import { assertLeasesHeld } from "#core/lease/lease.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { carriedBy } from "#core/plan/carries.ts";
import type { Action, Fetch, Plan } from "#core/plan/model.ts";
import { assertRemovable } from "#core/plan/removable.ts";
import { backupStamp } from "#core/store/backups.ts";
import { ensureScopeIgnore } from "#core/store/ignore.ts";
import { assertManagedPath } from "#core/store/managed-paths.ts";
import { PROJECTIONS_DIR, type Roots } from "#core/store/paths.ts";
import { assemble } from "./assemble.ts";
import { journal } from "./journal.ts";
import { linkInto, preflight, unlink } from "./link.ts";
import { record } from "./record.ts";
import { applyRegistrations } from "./registrations.ts";
import {
  type ApplyResult,
  addCloned,
  addLinked,
  addRecorded,
  addStaging,
  addUnlinked,
  type Run,
  type RunInputs,
  startRun,
} from "./run.ts";
import { cloneInto, prefetch, stage } from "./stage.ts";

const linked = (lock: Lock | undefined, name: string): number =>
  lock?.artifacts[name]?.links.length ?? 0;

export interface ApplyOptions {
  plan: Plan;
  roots: Roots;
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  onStep?: ((action: Action) => void) | undefined;
}

export async function apply({
  plan,
  roots,
  fetch,
  env,
  onStep,
}: ApplyOptions): Promise<ApplyResult> {
  const guards = await preflight(plan, roots, env);
  const before = await readLock(roots);
  await journal(plan, roots, guards);
  let stamp: string | undefined;
  const run = startRun(
    { roots, env, ahead: prefetch(plan, fetch), before, stamp: () => (stamp ??= backupStamp()) },
    guards,
  );

  let leaseCheckedAt = 0;
  for (const action of plan.actions) {
    // Reading the lease per action is a file read each; the lock write checks it again regardless.
    if (action.kind === "record" || Date.now() - leaseCheckedAt >= LEASE_CHECK_MS) {
      await assertLeasesHeld();
      leaseCheckedAt = Date.now();
    }
    onStep?.(action);
    if (action.kind !== "record")
      await assertManagedPath(action.to, roots, { leaf: action.kind !== "unlink", env });
    await applyAction(run, action);
  }
  const registered = await finish(run, plan);

  await rm(roots.applyJournal, { force: true });
  const { results } = run;
  return {
    performed: results.performed,
    installed: [...results.installed].sort(),
    added: Object.keys(results.recorded?.artifacts ?? {})
      .filter((name) => linked(before, name) === 0)
      .sort(),
    removed:
      results.recorded === undefined
        ? []
        : Object.keys(before?.artifacts ?? {})
            .filter((name) => linked(before, name) > 0 && linked(results.recorded, name) === 0)
            .sort(),
    lock: results.recorded,
    degraded: [...results.degraded].sort(),
    unstaged: [...results.unstaged].map(([name, { reason, error }]) => ({ name, reason, error })),
    kept: [...results.kept, ...registered],
    adopted: results.adopted,
    backedUp: results.backedUp,
    carried: await carriedBy(plan, results.recorded, roots),
    unrendered: results.unrendered,
  };
}

/** How stale a run's knowledge that it still holds the lease may be. */
const LEASE_CHECK_MS = 250;

/** Each step returns what it adds; this is the one place the run takes it in. */
async function applyAction(run: Run, action: Action): Promise<void> {
  const { results } = run;
  switch (action.kind) {
    case "stage":
      return addStaging(results, action.name, await stage(run, action));
    case "clone":
      return addCloned(results, action, await cloneInto(run, action));
    case "link":
      return addLinked(results, action, await linkInto(run, action));
    case "unlink":
      return addUnlinked(results, await unlink(run, action));
    case "record":
      return addRecorded(results, await record(run, action));
  }
}

/** Needs every clone landed first; returns the registrations it left to a person. */
async function finish(run: Run, plan: Plan): Promise<ApplyResult["kept"]> {
  const { roots, env, before } = run.inputs;
  const { plugins, fanned, projections, performed, recorded } = run.results;
  // At link time a projection would see only the kind whose artifact happened to be first.
  for (const [dir, { content, targets, document }] of plugins) {
    await assertManagedPath(dir, roots, { env });
    await assemble(dir, content, targets, document);
  }
  for (const [to, from] of fanned) {
    await assertRemovable(to, roots, env);
    await fanOut(from, to);
  }
  if (projections !== undefined) await pruneProjections(projections, run.inputs);
  if (plugins.size > 0 || Object.values(performed).some((count) => count > 0)) {
    await assertManagedPath(roots.artifacts, roots, { env });
    await ensureScopeIgnore(roots);
  }
  return applyRegistrations(plan.actions, roots, recorded ?? before);
}

/** A link assembles a namespace's projection and no unlink takes it, so it goes with its last row. */
async function pruneProjections(
  wanted: ReadonlySet<string>,
  { roots, env }: RunInputs,
): Promise<void> {
  const root = join(roots.artifacts, PROJECTIONS_DIR);
  await assertManagedPath(root, roots, { env });
  for (const { name: source } of await entries(root)) {
    await assertManagedPath(join(root, source), roots, { env });
    for (const { name: plugin } of await entries(join(root, source))) {
      const path = join(root, source, plugin);
      await assertManagedPath(path, roots, { env });
      if (!wanted.has(path)) await remove(path);
    }
    await rmdir(join(root, source)).catch(() => undefined);
  }
  await rmdir(root).catch(() => undefined);
}
