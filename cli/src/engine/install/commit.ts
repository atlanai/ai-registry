import { rm } from "node:fs/promises";
import { refuseOldCli } from "#core/engines.ts";
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

/** Checks the engine and recovers a crashed run's leftovers. */
export async function prepareWrite(
  { manifest, roots, lock }: Loaded,
  dryRun = false,
): Promise<Recovered> {
  refuseOldCli(manifest.engine);
  // Recovery removes files, which needs the lease; the next real run recovers.
  return dryRun ? { removed: [], skipped: [] } : recover(roots, lock, process.env);
}

export interface CommitOptions {
  loaded: Loaded;
  plan: Plan;
  acquired: readonly Acquired[];
  targets: readonly string[];
  onStep: (action: Action) => void;
  undo?: (() => Promise<void>) | undefined;
}

/** Applies a refused-clean plan between the user's apply hooks. */
export async function commit({
  loaded,
  plan,
  acquired,
  targets,
  onStep,
  undo = async () => {},
}: CommitOptions): Promise<ApplyResult> {
  const event = { targets: [...targets], aliases: Object.keys(loaded.manifest.registries) };
  let applied: ApplyResult;
  try {
    await runPipelineHooks("preApply", event);
    applied = await apply({
      plan,
      roots: loaded.roots,
      fetch: fetchFrom(acquired),
      env: process.env,
      onStep,
    });
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

/** A lock that no longer reads counts as changed. */
export async function lockUnchanged(roots: Roots, lock: Lock): Promise<boolean> {
  return readLock(roots).then(
    (now) => lockChanges(lock, now).length === 0,
    () => false,
  );
}
