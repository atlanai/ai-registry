import { lstatSync, readlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { redirection } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { isMissing, isStrictlyWithin, posixRelative } from "#core/fs/path.ts";
import { present, remove } from "#core/fs/tree.ts";
import { NAME } from "#core/product.ts";
import { type Roots, scopeName, stagingDir, toolHome, toolHomeRoot } from "#core/store/paths.ts";
import { resolveTargets, targetRoot } from "#core/target/index.ts";
import { fixedPrefix } from "#core/target/template.ts";

export type RemovableRoots = Pick<Roots, "scope" | "cwd" | "artifacts">;

type Removal = { how: "remove" } | { how: "unlink" } | { how: "refuse"; reason: string };

/** A folder aireg places things in; only `anchor` is resolved through links. */
interface Boundary {
  anchor: string;
  dir: string;
}

function boundaries(roots: RemovableRoots, env: NodeJS.ProcessEnv): Boundary[] {
  const project = roots.scope === "project";
  const scope = project ? roots.cwd : dirname(roots.artifacts);
  const home = toolHomeRoot(env);
  const found: Boundary[] = [
    { anchor: scope, dir: relative(scope, roots.artifacts) },
    { anchor: home, dir: relative(toolHome(env), stagingDir(env)) },
  ];
  for (const target of Object.values(resolveTargets(env))) {
    const root = targetRoot(target, roots.scope, roots.cwd, env);
    const anchor = project ? roots.cwd : root;
    for (const mapping of Object.values(target.kinds)) {
      if (mapping?.subdir === undefined) continue;
      found.push({ anchor, dir: relative(anchor, join(root, ...fixedPrefix(mapping.subdir))) });
    }
  }
  return found;
}

/** Removing a link never touches what it points at, and this one points into our tree. */
function ownLink(target: string, roots: RemovableRoots): boolean {
  const real = join(canonical(dirname(target)), basename(target));
  try {
    if (!lstatSync(real).isSymbolicLink()) return false;
    const to = resolve(dirname(real), readlinkSync(real));
    return isStrictlyWithin(canonical(dirname(roots.artifacts)), canonical(to));
  } catch {
    return false;
  }
}

/** Relative to the folder it was found under, which is how a person knows it. */
/** Spelled as the lock spells the path it is said beside, with forward slashes. */
function shown(anchor: string, at: string): string {
  return isStrictlyWithin(anchor, at) ? posixRelative(anchor, at) : at;
}

/**
 * A lock is repository-written, so a path goes only if spelled below an aireg folder with no link
 * on the way.
 */
export function removal(
  path: string,
  roots: RemovableRoots,
  env: NodeJS.ProcessEnv = process.env,
): Removal {
  const target = resolve(roots.cwd, path);
  // A target home set through its env var is canonical, while the lock spells paths as typed.
  const targets = [target, join(canonical(dirname(target)), basename(target))];
  for (const { anchor, dir } of boundaries(roots, env)) {
    const real = canonical(anchor);
    const spellings = [anchor, join(canonical(dirname(anchor)), basename(anchor)), real];
    const match = spellings
      .flatMap((base) => targets.map((at) => ({ base, at })))
      .find(({ base, at }) => isStrictlyWithin(join(base, dir), at));
    if (match === undefined) continue;
    if (ownLink(target, roots)) return { how: "unlink" };
    const found = redirection(real, join(real, relative(match.base, match.at)), false);
    if (found === undefined) return { how: "remove" };
    return {
      how: "refuse",
      reason:
        found.problem === "symlink"
          ? `${shown(real, found.at)} is a symlink, so it may lead outside ${scopeName(roots.scope)}`
          : `${shown(real, found.at)} is not a directory`,
    };
  }
  return { how: "refuse", reason: `${NAME} never places anything there` };
}

/** Checked again at deletion: a link can appear after planning. */
export async function assertRemovable(
  path: string,
  roots: RemovableRoots,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Removal> {
  const verdict = removal(path, roots, env);
  const target = resolve(roots.cwd, path);
  if (verdict.how === "refuse" && (await present(target))) {
    throw new AiregError(`Refusing to remove ${target}: ${verdict.reason}.`, {
      code: ErrorCode.Conflict,
    });
  }
  return verdict;
}

export async function removeContained(
  path: string,
  roots: RemovableRoots,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const verdict = await assertRemovable(path, roots, env);
  const target = resolve(roots.cwd, path);
  if (verdict.how === "unlink") {
    await unlink(target).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  } else if (verdict.how === "remove") {
    await remove(target);
  }
}
