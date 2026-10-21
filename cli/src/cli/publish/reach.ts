import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonicalAsync } from "#core/fs/canonical.ts";
import { posixRelative } from "#core/fs/path.ts";
import { isDirectory } from "#core/fs/tree.ts";
import { gitIn } from "#core/git.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import { type Export, type ExportDependency, isGlob, type Manifest } from "#core/manifest.ts";
import { formatAddress } from "#core/ref.ts";
import { type Exported, expand } from "./work.ts";

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

/** One entry's say over an artifact. */
interface Reach {
  entry: Export;
  /** It names the artifact itself, rather than reaching it through a glob. */
  named: boolean;
}

/** What an entry sets once for each artifact it reaches, where two entries can disagree. */
const SINGLE = ["version", "publish"] as const;

/** The same dependency, however an entry spells its path. */
function dependencyKey(need: ExportDependency): string {
  return need.type === "local" ? `./${artifactRoot(need.path)}` : formatAddress(need.ref);
}

/**
 * One value for the artifact: an entry naming it decides over one that only reaches it, and two
 * entries that decide alike must agree, so no entry quietly undoes another.
 */
function decide<K extends (typeof SINGLE)[number]>(
  key: K,
  reaches: readonly Reach[],
  shown: string,
): Export[K] {
  for (const named of [true, false]) {
    const setting = reaches.filter((each) => each.named === named && each.entry[key] !== undefined);
    const [first] = setting;
    if (first === undefined) continue;
    const other = setting.find((each) => !isDeepStrictEqual(each.entry[key], first.entry[key]));
    if (other !== undefined) {
      throw new AiregError(
        `Exports ${quoted(first.entry.path)} and ${quoted(other.entry.path)} set a different \`${key}\` for ${shown}.`,
        { code: ErrorCode.Invalid, hint: `Set \`${key}\` in one of them.` },
      );
    }
    return first.entry[key];
  }
  return undefined;
}

/** Every entry that reaches one artifact, as one: their lists combined, each single value decided. */
function merged(reaches: readonly Reach[], shown: string): Export {
  const [first] = reaches;
  const deciding = reaches.find((each) => each.named) ?? (first as Reach);
  const needs = new Map<string, ExportDependency>();
  for (const { entry } of reaches) {
    for (const need of entry.dependsOn) {
      const key = dependencyKey(need);
      if (!needs.has(key)) needs.set(key, need);
    }
  }
  return {
    path: deciding.entry.path,
    version: decide("version", reaches, shown),
    dependsOn: [...needs.values()],
    publish: decide("publish", reaches, shown),
  };
}

/** The artifacts one entry reaches, by their roots. */
async function reachedBy(
  entry: Export,
  base: string,
  tracked: readonly string[] | undefined,
  installed: ReadonlySet<string>,
): Promise<Set<string>> {
  if (!isGlob(entry.path)) {
    const path = resolve(base, entry.path);
    if (!existsSync(path)) {
      throw new AiregError(`Export ${quoted(entry.path)} names nothing in this project.`, {
        code: ErrorCode.NotFound,
        hint: "Check its path under `exports:`, or remove the entry.",
      });
    }
    await refuseOutside(entry, artifactRoot(path), base);
    return new Set([artifactRoot(path)]);
  }
  const roots = new Set<string>();
  for (const path of await expand(entry.path, base)) {
    const root = artifactRoot(path);
    if (!isWithin(base, root)) await refuseOutside(entry, root, base);
    if (installed.has(root)) continue;
    if (tracked !== undefined && !tracked.some((file) => isWithin(path, file))) continue;
    await refuseOutside(entry, root, base);
    roots.add(root);
  }
  return roots;
}

/**
 * Every artifact `exports:` reaches, by its absolute path, with the entries that reach it merged.
 * In a git repository a glob reaches only what git tracks, so scratch work beside an export is
 * not published, and never what aireg installed there; inside a folder, too, only what git
 * tracks is published. Every entry reaching an artifact applies
 * to it: their `depends_on` lists are combined, and an entry naming the artifact sets its
 * `version` and `publish` over a glob that only matches it.
 */
export async function exportsOn(
  manifest: Manifest,
  base: string,
  installed: ReadonlySet<string> = new Set(),
): Promise<Map<string, Exported>> {
  const tracked = manifest.exports.length > 0 ? await trackedFiles(base) : undefined;
  const reached = new Map<string, Reach[]>();
  for (const entry of manifest.exports) {
    for (const root of await reachedBy(entry, base, tracked, installed)) {
      const reach = { entry, named: !isGlob(entry.path) };
      reached.set(root, [...(reached.get(root) ?? []), reach]);
    }
  }
  const found = new Map<string, Exported>();
  for (const [root, reaches] of reached) {
    const files = await filesOf(root, tracked);
    found.set(root, { ...merged(reaches, posixRelative(base, root)), files });
  }
  return found;
}

/**
 * What a folder publishes, relative to it: in a git repository only what git tracks, so scratch
 * work inside a skill's folder stays out, and its entry file, which makes it the artifact it is.
 */
async function filesOf(
  root: string,
  tracked: readonly string[] | undefined,
): Promise<string[] | undefined> {
  if (tracked === undefined || !(await isDirectory(root))) return undefined;
  const inside = tracked
    .filter((file) => file !== root && isWithin(root, file))
    .map((file) => posixRelative(root, file));
  return [...new Set([SKILL_ENTRY, ...inside])].sort();
}
