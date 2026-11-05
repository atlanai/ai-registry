import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { dict } from "#core/fields.ts";
import { homeDir } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { withLease } from "#core/lease/lease.ts";
import { readLock } from "#core/lock.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { fetchFrom } from "#core/plan/acquire/sources.ts";
import { apply } from "#core/plan/apply/apply.ts";
import { recover } from "#core/plan/apply/journal.ts";
import { build } from "#core/plan/build/build.ts";
import type { Plan } from "#core/plan/model.ts";
import { spawnDetached } from "#core/process.ts";
import { NAME, REMOVE_AFTER_FLAG } from "#core/product.ts";
import { runningEntry } from "#core/release/launch.ts";
import { type Roots, roots, toolHome, userScopeDir } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { removeTree } from "./remove-after-exit.ts";
import { onPathIn } from "./shell-path.ts";

/** The files aireg put on this machine outside projects, as `aireg self uninstall` finds them. */
export interface Footprint {
  /** What your user scope placed in target folders. */
  links: string[];
  startupFiles: string[];
  folders: string[];
  /** Left in place: a CLI aireg did not install, or a folder that holds your home. */
  kept: string[];
}

export async function footprint(env: NodeJS.ProcessEnv = process.env): Promise<Footprint> {
  const { folders: own, kept } = folders(env);
  const entry = runningEntry();
  if (entry !== undefined && !isWithin(toolHome(env), canonical(entry))) kept.push(entry);
  return {
    links: linksOf(await teardownPlan(roots("user", homeDir(env), env)), env),
    startupFiles: await onPathIn(env),
    folders: own,
    kept,
  };
}

/** aireg's two folders that exist; a moved home that holds the home directory itself is kept. */
function folders(env: NodeJS.ProcessEnv): { folders: string[]; kept: string[] } {
  const home = homeDir(env);
  const found = { folders: [] as string[], kept: [] as string[] };
  for (const dir of [userScopeDir(env), toolHome(env)]) {
    if (existsSync(dir)) (isWithin(dir, home) ? found.kept : found.folders).push(dir);
  }
  return found;
}

/** The links in target folders; the copies they point at go with the scope's folder. */
function linksOf(plan: Plan, env: NodeJS.ProcessEnv): string[] {
  const dir = userScopeDir(env);
  return plan.actions.flatMap((action) =>
    action.kind === "unlink" && !isWithin(dir, action.to) ? [action.to] : [],
  );
}

/** With nothing declared every row is stale, so the planner unlinks all of them, as `remove` would. */
async function teardownPlan(scope: Roots): Promise<Plan> {
  const manifest = await readManifest(scope.manifest);
  return build(
    { ...manifest, artifacts: [], registries: dict() },
    await readLock(scope),
    [],
    { artifacts: dict() },
    { roots: scope, targets: [], targetTable: resolveTargets(), force: false, copy: false },
  );
}

/** aireg's own teardown of the user scope, under its lease so no job writes beside it. */
export async function unlinkUserScope(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const scope = roots("user", homeDir(env), env);
  return withLease(scope, { wait: true }, async () => {
    // A run that crashed may have linked paths the lock never recorded.
    await recover(scope, await readLock(scope));
    const plan = await teardownPlan(scope);
    await apply(plan, scope, fetchFrom([]));
    return linksOf(plan, env);
  });
}

/** Looked up again here, since the teardown itself may have written to either folder. */
export async function deleteFolders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const dir of folders(env).folders) {
    if (await removeTree(dir)) {
      deleted.push(dir);
      continue;
    }
    if (process.platform !== "win32" || !isWithin(canonical(dir), canonical(process.execPath))) {
      failed.push(dir);
      continue;
    }
    // Windows can move the running aireg.exe, though not delete it; across drives it cannot.
    const moved = await moveToTemp(process.execPath);
    if (moved !== undefined && (await removeTree(dir))) {
      deleted.push(dir);
      continue;
    }
    await deleteAfterExit(dir, moved ?? process.execPath).then(
      () => deleted.push(dir),
      () => failed.push(dir),
    );
  }
  return { deleted, failed };
}

/** Into the temp folder, which Windows cleans; this fails when TEMP is on another drive. */
async function moveToTemp(path: string): Promise<string | undefined> {
  const to = helperPath("uninstalled");
  return rename(path, to).then(
    () => to,
    () => undefined,
  );
}

function helperPath(suffix: string): string {
  return join(tmpdir(), `${NAME}-${suffix}-${randomBytes(4).toString("hex")}.exe`);
}

/**
 * A copy in the temp folder, which a copy can reach on any drive, deletes the folder once this
 * process exits; Windows cleans the copy with the rest of TEMP.
 */
async function deleteAfterExit(dir: string, executable: string): Promise<void> {
  const helper = helperPath("uninstall");
  await copyFile(executable, helper);
  spawnDetached(helper, [REMOVE_AFTER_FLAG, String(process.pid), dir]);
}
