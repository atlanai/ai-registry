import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { present, pruneEmptyParent } from "#core/fs/tree.ts";
import { type BackupItem, backupsDir, moveToBackup } from "#core/store/backups.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { canonicalId } from "#core/target/ids.ts";
import { targetRoot } from "#core/target/roots.ts";
import { type RemovableRoots, removal } from "./removable.ts";

type BackupRoots = RemovableRoots & Pick<Roots, "artifacts">;

/** Where a backed-up item would go back to, and what stands there now. */
export type Standing =
  | { state: "free"; to: string }
  | { state: "taken"; to: string }
  /** aireg's own link stands there, so the lock still tracks the path. */
  | { state: "installed"; to: string }
  | { state: "refused"; to: string; reason: string }
  /** No target here has a folder the run's filing names. */
  | { state: "unknown" };

/**
 * The path a run took the item from, read back from its filing: the target, then the folder
 * within it. A profile's `:` was filed as `-`, and an earlier id still names its target.
 */
export function originOf(
  item: Pick<BackupItem, "target" | "dir" | "name">,
  targetTable: Targets,
  roots: Pick<Roots, "scope" | "cwd">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const where = { scope: roots.scope, cwd: roots.cwd, env };
  const filedAs = (name: string) => name.replaceAll(":", "-");
  const named = canonicalId(targetTable, item.target);
  const found = new Set<string>();
  for (const target of Object.values(targetTable)) {
    if (target.name !== named && filedAs(target.name) !== item.target) continue;
    for (const mapping of Object.values(target.kinds)) {
      const subdir = mapping?.subdir;
      // A templated folder, such as a plugin cache, cannot be read back from one name.
      if (subdir === undefined || subdir.includes("{") || basename(subdir) !== item.dir) continue;
      if (mapping?.scope !== undefined && mapping.scope !== roots.scope) continue;
      found.add(join(targetRoot(target, where), subdir, item.name));
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export async function standing(
  item: BackupItem,
  targetTable: Targets,
  roots: BackupRoots,
  env: NodeJS.ProcessEnv,
): Promise<Standing> {
  const to = originOf(item, targetTable, roots, env);
  if (to === undefined) return { state: "unknown" };
  const verdict = removal(to, roots, env);
  if (verdict.how === "refuse") return { state: "refused", to, reason: verdict.reason };
  if (!(await present(to))) return { state: "free", to };
  return { state: verdict.how === "unlink" ? "installed" : "taken", to };
}

export interface PutBack {
  to: string;
  /** Where what stood there went, when it was replaced. */
  replaced?: string;
}

/**
 * Renames the item back. What stands there is only ever moved to a new run, and only when
 * `aside` gives that run's stamp; aireg's own link is never replaced.
 */
export async function putBack(
  item: BackupItem,
  to: string,
  roots: BackupRoots,
  env: NodeJS.ProcessEnv,
  aside?: () => string,
): Promise<PutBack> {
  const scope = dirname(roots.artifacts);
  // The item itself may be a link the person made; only the folders above it are checked.
  await assertUnredirected(scope, item.path, false);
  const verdict = removal(to, roots, env);
  if (verdict.how === "refuse") {
    throw new AiregError(`Refusing to restore ${to}: ${verdict.reason}.`, {
      code: ErrorCode.Conflict,
    });
  }
  let replaced: string | undefined;
  if (await present(to)) {
    if (aside === undefined || verdict.how === "unlink") {
      throw new AiregError(`${to} is taken, so ${item.name} was left in backups.`, {
        code: ErrorCode.Conflict,
      });
    }
    const within = join(item.target, item.dir, item.name);
    replaced = await moveToBackup(to, roots, aside(), within);
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(item.path, to);
  await pruneEmptyParent(item.path, backupsDir(roots));
  return replaced === undefined ? { to } : { to, replaced };
}
