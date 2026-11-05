import { rm } from "node:fs/promises";
import { writeAtomic } from "#core/fs/atomic.ts";
import { readTextIfPresent } from "#core/fs/path.ts";
import { runPipelineHooks } from "#core/hook/run.ts";
import { type Lock, lockChanges, readLock } from "#core/lock.ts";
import { fetchFrom } from "#core/plan/acquire/sources.ts";
import { apply } from "#core/plan/apply/apply.ts";
import { type Recovered, recover } from "#core/plan/apply/journal.ts";
import type { ApplyResult } from "#core/plan/apply/run.ts";
import type { Acquired, Action, Plan } from "#core/plan/model.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Loaded } from "#engine/scope/load.ts";
import { refuseOldCli } from "./refusals.ts";

/** Checks the engine and recovers a crashed run's leftovers. */
export async function prepareWrite(
  { manifest, roots, lock }: Loaded,
  dryRun = false,
): Promise<Recovered> {
  refuseOldCli(manifest.engine);
  // Recovery removes files, which only a run holding the lease may do; the next real run recovers.
  return dryRun ? { removed: [], skipped: [] } : recover(roots, lock);
}

/** Applies a refused-clean plan between the user's apply hooks; `undo` runs when it fails. */
export async function commit(
  loaded: Loaded,
  plan: Plan,
  acquired: readonly Acquired[],
  targets: readonly string[],
  onStep: (action: Action) => void,
  undo: () => Promise<void> = async () => {},
): Promise<ApplyResult> {
  const event = { targets: [...targets], aliases: Object.keys(loaded.manifest.registries) };
  let applied: ApplyResult;
  try {
    await runPipelineHooks("preApply", event);
    applied = await apply(plan, loaded.roots, fetchFrom(acquired), onStep);
  } catch (error) {
    await undo();
    throw error;
  }
  await runPipelineHooks("postApply", event);
  return applied;
}

/** Undoes this run's write only; a file someone changed since is left as they wrote it. */
export async function restore(
  path: string,
  before: string | undefined,
  written: string | undefined,
): Promise<void> {
  if ((await readTextIfPresent(path)) !== written) return;
  if (before === undefined) await rm(path, { force: true });
  else await writeAtomic(path, before);
}

/** Whether the lock on disk is still the one the run started from. */
export async function unrecorded(roots: Roots, lock: Lock): Promise<boolean> {
  return readLock(roots).then(
    (now) => lockChanges(lock, now).length === 0,
    () => false,
  );
}
