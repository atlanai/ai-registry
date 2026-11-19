import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ifPresent } from "#adapter/files.ts";
import { isWithin } from "#adapter/paths.ts";
import { dict } from "#core/fields.ts";
import { fanOutEntries } from "#core/fs/link.ts";
import { homeDir } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { withLease } from "#core/lease/lease.ts";
import { readLock } from "#core/lock.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { fetchFrom } from "#core/plan/acquire/sources.ts";
import { apply } from "#core/plan/apply/apply.ts";
import { recover } from "#core/plan/apply/journal.ts";
import { guardsOf } from "#core/plan/apply/link.ts";
import type { BackedUp } from "#core/plan/apply/run.ts";
import { build } from "#core/plan/build/build.ts";
import type { Plan } from "#core/plan/model.ts";
import { removeContained } from "#core/plan/removable.ts";
import { spawnDetached } from "#core/process.ts";
import { NAME, REMOVE_AFTER_FLAG } from "#core/product.ts";
import { runningEntry } from "#core/release/launch.ts";
import { type Roots, roots, toolHome, userScopeDir } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { removeTree } from "./remove-after-exit.ts";
import { onPathIn } from "./shell-path.ts";

/** The files aireg put on this machine outside projects. */
export interface Footprint {
  links: string[];
  startupFiles: string[];
  folders: string[];
  /** Left in place, as the command's result describes `kept`. */
  kept: string[];
}

export async function footprint(env: NodeJS.ProcessEnv = process.env): Promise<Footprint> {
  const { links, yours } = await teardownPlan(roots("user", homeDir(env), env), env);
  return {
    links,
    startupFiles: await onPathIn(env),
    folders: folders(env).folders,
    kept: [...untouched(env), ...yours],
  };
}

/** Left whatever the teardown finds: a CLI aireg did not install, and a folder holding your home. */
export function untouched(env: NodeJS.ProcessEnv = process.env): string[] {
  const { kept } = folders(env);
  const entry = runningEntry();
  if (entry !== undefined && !isWithin(toolHome(env), canonical(entry))) kept.push(entry);
  return kept;
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

interface Teardown {
  plan: Plan;
  links: string[];
  /** Folders of yours where aireg's link was, left whole. */
  yours: string[];
  /** Fan-outs you added to, which lose only aireg's entries. */
  fanned: string[];
}

/**
 * With nothing declared every row is stale, so the planner unlinks all of them. Nothing of yours
 * goes to `unlink`, which would back it up into the folder uninstall deletes.
 */
async function teardownPlan(scope: Roots, env: NodeJS.ProcessEnv): Promise<Teardown> {
  const manifest = await readManifest(scope.manifest);
  const plan = await build(
    { ...manifest, artifacts: [], registries: dict() },
    await readLock(scope),
    [],
    { artifacts: dict() },
    { roots: scope, env, targets: [], targetTable: resolveTargets(env), force: false, copy: false },
  );
  const guards = await guardsOf(plan, { roots: scope, env });
  const theirs = new Set(
    plan.actions.flatMap((action) =>
      action.kind === "unlink" && guards.get(action.to) === "backup" ? [action] : [],
    ),
  );
  const fanned = new Set(
    [...theirs].flatMap((action) => (action.link?.mode === "fanout" ? [action.to] : [])),
  );
  const yours = new Set([...theirs].map((action) => action.to).filter((path) => !fanned.has(path)));
  return {
    plan: {
      ...plan,
      actions: plan.actions.filter((action) => action.kind !== "unlink" || !theirs.has(action)),
    },
    links: linksOf(plan, env).filter((path) => !yours.has(path)),
    yours: [...yours],
    fanned: [...fanned],
  };
}

/** Under the scope's lease, so no job writes beside it. */
export async function unlinkUserScope(
  env: NodeJS.ProcessEnv,
): Promise<{ links: string[]; kept: string[] }> {
  const scope = roots("user", homeDir(env), env);
  return withLease(scope, { wait: true }, async () => {
    // A run that crashed may have linked paths the lock never recorded.
    await recover(scope, await readLock(scope), env);
    const { plan, links, yours, fanned } = await teardownPlan(scope, env);
    // Read while the store they mirror is still there; the teardown removes it.
    const entries = (
      await Promise.all(fanned.map((dir) => fanOutEntries(dir, dirname(scope.artifacts))))
    ).flat();
    const { backedUp } = await apply({ plan, roots: scope, fetch: fetchFrom([]), env });
    for (const entry of entries) await removeContained(entry, scope, env);
    const restored = new Set(await putBack(backedUp));
    return {
      links: links.filter((path) => !restored.has(path)),
      kept: [...yours, ...restored],
    };
  });
}

/** The scope's backups go with it, so what apply moved there since the plan was read goes back. */
async function putBack(backedUp: readonly BackedUp[]): Promise<string[]> {
  for (const { path, to } of backedUp) {
    if ((await ifPresent(lstat(path))) !== undefined) {
      throw new Error(`${path} was taken during the uninstall, so your copy stays in ${to}.`);
    }
    // Unlink prunes the parent it emptied.
    await mkdir(dirname(path), { recursive: true });
    await rename(to, path);
  }
  return backedUp.map(({ path }) => path);
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
 * A copy in TEMP, reachable from any drive, deletes the folder once this process exits.
 * Windows cleans the copy with the rest of TEMP.
 */
async function deleteAfterExit(dir: string, executable: string): Promise<void> {
  const helper = helperPath("uninstall");
  await copyFile(executable, helper);
  spawnDetached(helper, [REMOVE_AFTER_FLAG, String(process.pid), dir]);
}
