import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonicalAsync } from "#core/fs/canonical.ts";
import { posixRelative } from "#core/fs/path.ts";
import { gitIn } from "#core/git.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import { type Export, isGlob, type Manifest } from "#core/manifest.ts";
import { expand } from "./work.ts";

// Which artifacts `exports:` reaches in this project, and the entry whose rules apply to each.

/** A skill is its folder, however an entry reaches it, so one path names one export. */
export function artifactRoot(path: string): string {
  return basename(path) === SKILL_ENTRY ? dirname(path) : path;
}

/** What git tracks below `base`, or undefined outside a repository, where nothing is filtered. */
async function trackedFiles(base: string): Promise<string[] | undefined> {
  const listed = await gitIn(base, ["ls-files", "-z"]);
  if (listed.code !== 0) return undefined;
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => resolve(base, file));
}

/** Where this scope's lockfile says aireg put an installed artifact: its copy and each link to it. */
export function installedPaths(lock: Lock, base: string): Set<string> {
  return new Set(
    Object.values(lock.artifacts).flatMap((row) => [
      resolve(base, row.path),
      ...row.links.map((link) => resolve(base, link.path)),
    ]),
  );
}

/**
 * An export is published from where it really is: one that a link, or a glob, takes outside the
 * project would publish whatever is there, so it is refused. A folder's own links are refused
 * when its files are read, so its root decides where everything in it sits.
 */
async function refuseOutside(entry: Export, path: string, base: string): Promise<void> {
  const [real, project] = await Promise.all([canonicalAsync(path), canonicalAsync(base)]);
  if (isWithin(base, path) && isWithin(project, real)) return;
  const shown = isWithin(base, path) ? posixRelative(base, path) : path;
  throw new AiregError(
    `Export ${quoted(entry.path)} reaches ${shown}, which is outside this project.`,
    {
      code: ErrorCode.Invalid,
      hint: "Exports publish only what is in the project: replace a link with the files it points to, or leave the path out of `exports:`.",
    },
  );
}

/**
 * Every path `exports:` names, by its absolute path, with the entry whose rules apply to it.
 * In a git repository a glob reaches only what git tracks, so scratch work beside an export
 * is not published, and never what aireg installed there; a mapping for one of its paths
 * refines what the glob says.
 */
export async function exportsOn(
  manifest: Manifest,
  base: string,
  installed: ReadonlySet<string> = new Set(),
): Promise<Map<string, Export>> {
  const tracked = manifest.exports.some((entry) => isGlob(entry.path))
    ? await trackedFiles(base)
    : undefined;
  const found = new Map<string, Export>();
  for (const entry of manifest.exports) {
    if (!isGlob(entry.path)) continue;
    for (const path of await expand(entry.path, base)) {
      const root = artifactRoot(path);
      if (!isWithin(base, root)) await refuseOutside(entry, root, base);
      if (installed.has(root)) continue;
      if (tracked !== undefined && !tracked.some((file) => isWithin(path, file))) continue;
      await refuseOutside(entry, root, base);
      found.set(root, entry);
    }
  }
  for (const entry of manifest.exports) {
    if (isGlob(entry.path)) continue;
    const path = resolve(base, entry.path);
    if (!existsSync(path)) {
      throw new AiregError(`Export ${quoted(entry.path)} names nothing in this project.`, {
        code: ErrorCode.NotFound,
        hint: "Check its path under `exports:`, or remove the entry.",
      });
    }
    await refuseOutside(entry, artifactRoot(path), base);
    found.set(artifactRoot(path), entry);
  }
  return found;
}
