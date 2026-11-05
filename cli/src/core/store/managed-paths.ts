import { dirname, join, relative } from "node:path";
import { assertUnredirected, redirection } from "#adapter/files.ts";
import { isWithin } from "#adapter/paths.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Roots, stagingDir, toolHome, toolHomeRoot } from "#core/store/paths.ts";

/** Target roots may be shared; only scope-owned and staging trees are guarded here. */
export async function guardManagedPath(
  path: string,
  roots: Roots,
  includeLeaf = true,
  env: NodeJS.ProcessEnv = process.env,
  /** Folders this pass already checked, for a caller guarding many paths at once. */
  verified?: Set<string>,
): Promise<void> {
  if (isWithin(dirname(roots.artifacts), path)) {
    await assertUnredirected(scopeRoot(roots), path, includeLeaf, verified);
  } else {
    const home = toolHome(env);
    // Resolve only the explicitly configured root, never a link below it.
    const selected = toolHomeRoot(env);
    const staging = isWithin(selected, path) ? join(home, relative(selected, path)) : path;
    if (isWithin(stagingDir(env), staging)) {
      await assertUnredirected(home, staging, includeLeaf, verified);
    }
  }
}

/** Where the walk for links starts: a project from its own folder, the user scope from its own. */
function scopeRoot(roots: Roots): string {
  return roots.scope === "project" ? roots.cwd : dirname(roots.artifacts);
}

/**
 * Refuses a copy reached through a link: a repository ships its .registry, so a link
 * there could publish a folder from your home.
 */
export function refuseRedirectedCopy(name: string, path: string, roots: Roots): void {
  const found = redirection(scopeRoot(roots), path);
  if (found === undefined) return;
  const what = found.problem === "symlink" ? "a symlink" : "not a folder";
  throw new AiregError(`${name} was not published because ${found.at} is ${what}.`, {
    code: ErrorCode.Invalid,
    hint: "An installed copy is read only through real folders. Remove the link, then run `aireg update` to restore the copy.",
  });
}
