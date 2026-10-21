import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { frontmatter } from "#core/catalog/frontmatter.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonicalAsync } from "#core/fs/canonical.ts";
import { posixRelative } from "#core/fs/path.ts";
import { isDirectory } from "#core/fs/tree.ts";
import { gitIn } from "#core/git.ts";
import { type ArtifactKind, SKILL_ENTRY } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import {
  type Export,
  type ExportDependency,
  type ExportFile,
  isGlob,
  type Manifest,
} from "#core/manifest.ts";
import { formatAddress } from "#core/ref.ts";
import { chooseFiles } from "./files.ts";
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
  /** It names the artifact itself, rather than reaching it through a glob or its folder. */
  named: boolean;
}

/** What an entry sets once for each artifact it reaches, where two entries can disagree. */
const SINGLE = ["version", "publish", "kind"] as const;

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

/** Each list's items once, in the order the entries give them. */
function combined<T>(
  lists: readonly (readonly T[] | undefined)[],
  key: (item: T) => string,
): T[] | undefined {
  if (lists.every((items) => items === undefined)) return undefined;
  const out = new Map<string, T>();
  for (const item of lists.flatMap((items) => items ?? [])) {
    if (!out.has(key(item))) out.set(key(item), item);
  }
  return [...out.values()];
}

/** Every entry that reaches one artifact, as one: their lists combined, each single value decided. */
function merged(reaches: readonly Reach[], shown: string): Export {
  const [first] = reaches;
  const deciding = reaches.find((each) => each.named) ?? (first as Reach);
  const entries = reaches.map((each) => each.entry);
  const kind = decide("kind", reaches, shown);
  const ignore = combined(
    entries.map((entry) => entry.ignore),
    (pattern) => pattern,
  );
  const include = combined<ExportFile>(
    entries.map((entry) => entry.include),
    (file) => `${file.from}\0${file.as}`,
  );
  return {
    path: deciding.entry.path,
    version: decide("version", reaches, shown),
    dependsOn:
      combined(
        entries.map((entry) => entry.dependsOn),
        dependencyKey,
      ) ?? [],
    publish: decide("publish", reaches, shown),
    ...(kind === undefined ? {} : { kind }),
    ...(ignore === undefined ? {} : { ignore }),
    ...(include === undefined ? {} : { include }),
  };
}

/** What a path an entry reaches holds: an artifact, by its root and kind, or why it is none. */
type Held = { root: string; kind: ArtifactKind } | { stray: string };

const NOT_AGENT = "has no name and description in its front matter, so it is no agent";

/** Whether a Markdown file's front matter gives an agent's name and description. */
async function namesAgent(path: string): Promise<boolean> {
  const meta = frontmatter(await readFile(path, "utf8"));
  return meta.name !== undefined && meta.description !== undefined;
}

const shownAt = (path: string, base: string) => posixRelative(base, path);

/** A folder holding SKILL.md is a skill. */
function heldIn(path: string): Held {
  return existsSync(join(path, SKILL_ENTRY))
    ? { root: path, kind: "skill" }
    : { stray: "holds no SKILL.md" };
}

/**
 * A skill is a folder holding SKILL.md, reached by either; an agent is a `.md` file whose front
 * matter gives its name and description, so a README or a note beside them is never one.
 */
async function heldAt(path: string): Promise<Held> {
  if (await isDirectory(path)) return heldIn(path);
  if (basename(path) === SKILL_ENTRY) return heldIn(dirname(path));
  if (extname(path) !== ".md") {
    return { stray: "is neither a skill folder nor an agent's .md file" };
  }
  return (await namesAgent(path)) ? { root: path, kind: "agent" } : { stray: NOT_AGENT };
}

/** What every entry is read against, and the notes on what an entry skipped. */
interface Reading {
  base: string;
  tracked: readonly string[] | undefined;
  installed: ReadonlySet<string>;
  notes: string[];
}

/** What an entry reaches: artifacts by their roots and kinds, and whether it names one itself. */
interface Reaching {
  roots: Map<string, ArtifactKind>;
  named: boolean;
}

const NAME_HINT =
  "Name a skill folder that holds SKILL.md, an agent's .md file whose front matter has a name and a description, or a folder of them.";

/** Whether git leaves a path out of what it tracks, so no entry reaching through a folder sees it. */
function untracked(path: string, reading: Reading): boolean {
  const { tracked } = reading;
  return tracked !== undefined && !tracked.some((file) => isWithin(path, file));
}

/** A path that a glob or a folder reaches, which is skipped with a note when it is no artifact. */
async function reachThrough(
  entry: Export,
  path: string,
  reading: Reading,
  into: Map<string, ArtifactKind>,
) {
  const { base, installed } = reading;
  const root = artifactRoot(path);
  if (!isWithin(base, root)) await refuseOutside(entry, root, base);
  if (installed.has(root) || untracked(path, reading)) return;
  await refuseOutside(entry, root, base);
  const held = await heldAt(path);
  if ("root" in held) into.set(held.root, held.kind);
  else reading.notes.push(`Skipped ${shownAt(path, base)}, which ${held.stray}.`);
}

/** The folder an entry names, which holds no artifact itself: each one directly inside it. */
async function reachInside(
  entry: Export,
  folder: string,
  reading: Reading,
): Promise<Map<string, ArtifactKind>> {
  const names = (await readdir(folder)).sort();
  for (const name of entry.exclude ?? []) {
    if (names.includes(name)) continue;
    throw new AiregError(
      `Export ${quoted(entry.path)} excludes ${quoted(name)}, which is not in it.`,
      {
        code: ErrorCode.NotFound,
        hint: "Check the names under `exclude`, each directly inside the folder.",
      },
    );
  }
  const roots = new Map<string, ArtifactKind>();
  for (const name of names) {
    if (entry.exclude?.includes(name) === true) continue;
    await reachThrough(entry, join(folder, name), reading, roots);
  }
  return roots;
}

/** The one artifact an entry names, or the folder of them it names. */
async function namedBy(entry: Export, reading: Reading): Promise<Reaching> {
  const path = resolve(reading.base, entry.path);
  if (!existsSync(path)) {
    throw new AiregError(`Export ${quoted(entry.path)} names nothing in this project.`, {
      code: ErrorCode.NotFound,
      hint: "Check its path under `exports:`, or remove the entry.",
    });
  }
  await refuseOutside(entry, artifactRoot(path), reading.base);
  const held = await heldAt(path);
  if ("root" in held) {
    if (entry.exclude !== undefined) {
      throw new AiregError(
        `Export ${quoted(entry.path)} sets \`exclude\`, but it is one artifact, not a folder of them.`,
        {
          code: ErrorCode.Invalid,
          hint: "Remove `exclude`, or give the folder holding it instead.",
        },
      );
    }
    const single = held.kind === "agent" && held.root === path && !(await isDirectory(path));
    if (single && (entry.include !== undefined || entry.ignore !== undefined)) {
      throw new AiregError(
        `Export ${quoted(entry.path)} sets \`${entry.include === undefined ? "ignore" : "include"}\`, but an agent's .md file is one file.`,
        {
          code: ErrorCode.Invalid,
          hint: "Make it a folder agent, with its file as AGENT.md, to publish other files with it.",
        },
      );
    }
    return { roots: new Map([[held.root, held.kind]]), named: true };
  }
  if (await isDirectory(path))
    return { roots: await reachInside(entry, path, reading), named: false };
  throw new AiregError(`Export ${quoted(entry.path)} is not an artifact: it ${held.stray}.`, {
    code: ErrorCode.Invalid,
    hint: NAME_HINT,
  });
}

/** The artifacts one entry reaches, by their roots; a glob skips anything else it matches, with a note. */
async function reachedBy(entry: Export, reading: Reading): Promise<Reaching> {
  const reached = isGlob(entry.path)
    ? { roots: new Map<string, ArtifactKind>(), named: false }
    : await namedBy(entry, reading);
  if (isGlob(entry.path)) {
    for (const path of await expand(entry.path, reading.base)) {
      await reachThrough(entry, path, reading, reached.roots);
    }
  }
  refuseKind(entry, reached.roots, reading.base);
  return reached;
}

const aKind = (kind: ArtifactKind) => `${kind === "agent" ? "an" : "a"} ${kind}`;

/** With `kind`, an entry reaching anything else is refused, naming what it reached. */
function refuseKind(entry: Export, roots: ReadonlyMap<string, ArtifactKind>, base: string): void {
  if (entry.kind === undefined) return;
  for (const [root, kind] of roots) {
    if (kind === entry.kind) continue;
    throw new AiregError(
      `Export ${quoted(entry.path)} reaches ${shownAt(root, base)}, which is ${aKind(kind)}, not ${aKind(entry.kind)}.`,
      {
        code: ErrorCode.Invalid,
        hint: isGlob(entry.path)
          ? "Narrow the glob, or remove `kind`."
          : "Leave it out with `exclude`, move it, or remove `kind`.",
      },
    );
  }
}

/** What `exports:` reaches, a note on each path it skipped that is no artifact, and warnings. */
export interface Reached {
  found: Map<string, Exported>;
  notes: string[];
  warnings: string[];
}

/**
 * Every artifact `exports:` reaches, by its absolute path, with the entries that reach it merged.
 * In a git repository an entry reaching through a glob or a folder reaches only what git tracks,
 * so scratch work beside an export is not published, and never what aireg installed there;
 * inside a folder, too, only what git tracks is published. Every entry reaching an artifact
 * applies to it: their lists are combined, and an entry naming the artifact sets its `version`,
 * `publish` and `kind` over one that only reaches it.
 */
export async function exportsOn(
  manifest: Manifest,
  base: string,
  installed: ReadonlySet<string> = new Set(),
): Promise<Reached> {
  const tracked = manifest.exports.length > 0 ? await trackedFiles(base) : undefined;
  const reading: Reading = { base, tracked, installed, notes: [] };
  const reached = new Map<string, { kind: ArtifactKind; reaches: Reach[] }>();
  for (const entry of manifest.exports) {
    const { roots, named } = await reachedBy(entry, reading);
    for (const [root, kind] of roots) {
      const at = reached.get(root) ?? { kind, reaches: [] };
      at.reaches.push({ entry, named });
      reached.set(root, at);
    }
  }
  const found = new Map<string, Exported>();
  const matched = new Set<string>();
  for (const [root, { kind, reaches }] of reached) {
    const exported = merged(reaches, shownAt(root, base));
    const files = (await isDirectory(root))
      ? await chooseFiles(
          { root, kind, entries: reaches.map((each) => each.entry), tracked, matched },
          base,
        )
      : undefined;
    found.set(root, { ...exported, files });
  }
  return { found, notes: reading.notes, warnings: unmatchedPatterns(manifest.exports, matched) };
}

/** A warning on each `ignore` pattern that left nothing out of anything its entry reaches. */
function unmatchedPatterns(entries: readonly Export[], matched: ReadonlySet<string>): string[] {
  return entries.flatMap((entry) =>
    (entry.ignore ?? [])
      .filter((pattern) => !matched.has(`${entry.path}\0${pattern}`))
      .map(
        (pattern) =>
          `Export ${quoted(entry.path)} ignores ${quoted(pattern)}, which matches no file it publishes, so it leaves nothing out.`,
      ),
  );
}
