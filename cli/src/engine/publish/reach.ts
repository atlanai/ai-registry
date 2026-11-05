import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { frontmatter } from "#core/frontmatter.ts";
import { posixRelative } from "#core/fs/path.ts";
import { canonicalAsync } from "#core/fs/realpath.ts";
import { isDirectory } from "#core/fs/tree.ts";
import { AGENT_ENTRY } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import { type ExportFile, isGlob } from "#core/manifest/export-fields.ts";
import type { Export, ExportDependency, Manifest } from "#core/manifest/model.ts";
import { gitIn } from "#core/process.ts";
import { formatAddress } from "#core/ref.ts";
import { chooseFiles, ignoredBy } from "./files.ts";
import { type Exported, expand } from "./work.ts";

/** A folder artifact is its folder, however an entry reaches it, so one path names one export. */
export function artifactRoot(path: string): string {
  const name = basename(path);
  return name === SKILL_ENTRY || name === AGENT_ENTRY ? dirname(path) : path;
}

export function installedPaths(lock: Lock, base: string): Set<string> {
  return new Set(
    Object.values(lock.artifacts).flatMap((row) => [
      resolve(base, row.path),
      ...row.links.map((link) => resolve(base, link.path)),
    ]),
  );
}

/** Repository globs and folders reach only tracked files. */
export async function exportsOn(
  manifest: Manifest,
  base: string,
  installed: ReadonlySet<string> = new Set(),
): Promise<Reached> {
  const tracked = manifest.exports.length > 0 ? await trackedFiles(base) : undefined;
  const reading: Reading = { base, tracked, installed };
  const reached = new Map<string, { kind: ArtifactKind; reaches: Reach[] }>();
  const kinds = new Map<string, ArtifactKind>();
  const notes: string[] = [];
  for (const listed of manifest.exports) {
    const { roots, named, notes: skipped } = await reachedBy(listed, reading);
    const needed = await neededBy(listed, reading);
    notes.push(...skipped, ...needed.notes);
    for (const [root, kind] of needed.kinds) kinds.set(root, kind);
    for (const [root, kind] of roots) {
      const at = reached.get(root) ?? { kind, reaches: [] };
      at.reaches.push({ entry: { ...listed, dependsOn: needed.dependsOn(root) }, named });
      reached.set(root, at);
    }
  }
  const exports = new Map<string, Exporting>();
  for (const [root, { kind, reaches }] of reached) {
    exports.set(root, { kind, exported: merged(reaches, shownAt(root, base)) });
  }
  for (const [root, needed] of exportNeeded(exports, kinds, manifest.exports, reading)) {
    exports.set(root, needed);
  }
  const found = new Map<string, Exported>();
  const matched = new Set<string>();
  for (const [root, { kind, exported }] of exports) {
    const entries = reached.get(root)?.reaches.map((each) => each.entry) ?? [exported];
    const chosen = (await isDirectory(root))
      ? await chooseFiles({ root, kind, entries, tracked, exported: exports.keys() }, base)
      : undefined;
    for (const pattern of chosen?.matched ?? []) matched.add(pattern);
    found.set(root, { ...exported, files: chosen?.files });
  }
  return {
    found,
    notes: [...new Set(notes)],
    warnings: unmatchedPatterns(manifest.exports, matched),
  };
}

async function trackedFiles(base: string): Promise<string[] | undefined> {
  const listed = await gitIn(base, ["ls-files", "-z"]);
  if (listed.code !== 0) return undefined;
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => resolve(base, file));
}

interface Reach {
  entry: Export;
  /** Names the artifact itself rather than reaching it through a glob or folder. */
  named: boolean;
}

const SINGLE = ["version", "publish", "kind"] as const;

async function reachedBy(entry: Export, reading: Reading): Promise<Reaching> {
  const reached = isGlob(entry.path)
    ? { ...(await reachEach(entry, await expand(entry.path, reading.base), reading)), named: false }
    : await namedBy(entry, reading);
  refuseKind(entry, reached.roots, reading.base);
  return reached;
}

async function namedBy(entry: Export, reading: Reading): Promise<Reaching> {
  const path = resolve(reading.base, entry.path);
  if (!existsSync(path)) {
    throw new AiregError(`Export ${quoted(entry.path)} names nothing in this project.`, {
      code: ErrorCode.NotFound,
      hint: "Check its path under `exports:`, or remove the entry.",
    });
  }
  await refuseOutside(entry, artifactRoot(path), reading.base);
  const held = await heldAt(path, reading.base);
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
    return { roots: new Map([[held.root, held.kind]]), notes: [], named: true };
  }
  if (await isPlainFolder(path)) {
    return { ...(await reachInside(entry, path, reading, entry.exclude ?? [])), named: false };
  }
  throw new AiregError(`Export ${quoted(entry.path)} is not an artifact: it ${held.stray}.`, {
    code: ErrorCode.Invalid,
    hint: NAME_HINT,
  });
}

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

async function heldAt(path: string, base: string): Promise<Held> {
  if (await isDirectory(path)) return heldIn(path, base);
  if (basename(path) === SKILL_ENTRY || basename(path) === AGENT_ENTRY) {
    return heldIn(dirname(path), base);
  }
  if (extname(path) !== ".md") {
    return { stray: "is neither a skill or agent folder nor an agent's .md file" };
  }
  if (!(await namesAgent(path))) return { stray: NOT_AGENT };
  const folder = path.slice(0, -".md".length);
  if (existsSync(join(folder, AGENT_ENTRY))) refuseTwice(folder, base);
  return { root: path, kind: "agent" };
}

type Held = { root: string; kind: ArtifactKind } | { stray: string };

const NOT_AGENT = "has no name and description in its front matter, so it is no agent";

async function heldIn(path: string, base: string): Promise<Held> {
  const skill = existsSync(join(path, SKILL_ENTRY));
  const agent = existsSync(join(path, AGENT_ENTRY));
  if (skill) return { root: path, kind: "skill" };
  if (!agent) return { stray: "holds no SKILL.md or AGENT.md" };
  refuseTwice(path, base);
  return (await namesAgent(join(path, AGENT_ENTRY)))
    ? { root: path, kind: "agent" }
    : { stray: `holds an AGENT.md that ${NOT_AGENT}` };
}

const shownAt = (path: string, base: string) => posixRelative(base, path);

function refuseTwice(folder: string, base: string): void {
  if (!existsSync(`${folder}.md`)) return;
  const [file, agent] = [`${folder}.md`, join(folder, AGENT_ENTRY)].map((path) =>
    shownAt(path, base),
  );
  throw new AiregError(`${file} and ${agent} are one agent written twice.`, {
    code: ErrorCode.Invalid,
    hint: "Keep one of them: the folder, with its AGENT.md, or the one file.",
  });
}

async function namesAgent(path: string): Promise<boolean> {
  const meta = frontmatter(await readFile(path, "utf8"));
  return meta.name !== undefined && meta.description !== undefined;
}

async function isPlainFolder(path: string): Promise<boolean> {
  const entryFile = [SKILL_ENTRY, AGENT_ENTRY].some((name) => existsSync(join(path, name)));
  return !entryFile && (await isDirectory(path));
}

interface Reading {
  base: string;
  tracked: readonly string[] | undefined;
  installed: ReadonlySet<string>;
}

interface Found {
  roots: Map<string, ArtifactKind>;
  notes: string[];
}

interface Reaching extends Found {
  named: boolean;
}

const NAME_HINT =
  "Name a skill folder that holds SKILL.md, an agent's folder that holds AGENT.md, an agent's .md file whose front matter has a name and a description, or a folder of them.";

async function reachInside(
  entry: Export,
  folder: string,
  reading: Reading,
  exclude: readonly string[],
): Promise<Found> {
  const names = (await readdir(folder)).sort();
  for (const name of exclude) {
    if (names.includes(name)) continue;
    throw new AiregError(
      `Export ${quoted(entry.path)} excludes ${quoted(name)}, which is not in it.`,
      {
        code: ErrorCode.NotFound,
        hint: "Check the names under `exclude`, each directly inside the folder.",
      },
    );
  }
  const paths = names.filter((name) => !exclude.includes(name)).map((name) => join(folder, name));
  return reachEach(entry, paths, reading);
}

async function reachEach(
  entry: Export,
  paths: readonly string[],
  reading: Reading,
): Promise<Found> {
  const roots = new Map<string, ArtifactKind>();
  const notes: string[] = [];
  for (const path of paths) {
    const held = await reachThrough(entry, path, reading);
    if (held === undefined) continue;
    if ("root" in held) roots.set(held.root, held.kind);
    else notes.push(`Skipped ${shownAt(path, reading.base)}, which ${held.stray}.`);
  }
  return { roots, notes };
}

/** Undefined for a path aireg installed or git does not track. */
async function reachThrough(
  entry: Export,
  path: string,
  reading: Reading,
): Promise<Held | undefined> {
  const { base, installed } = reading;
  const root = artifactRoot(path);
  if (!isWithin(base, root)) await refuseOutside(entry, root, base);
  if (installed.has(root) || untracked(path, reading)) return undefined;
  await refuseOutside(entry, root, base);
  return heldAt(path, base);
}

function untracked(path: string, reading: Reading): boolean {
  const { tracked } = reading;
  return tracked !== undefined && !tracked.some((file) => isWithin(path, file));
}

const aKind = (kind: ArtifactKind) => `${kind === "agent" ? "an" : "a"} ${kind}`;

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

interface Needed {
  /** Never the artifact itself, unless named. */
  dependsOn: (root: string) => ExportDependency[];
  kinds: Map<string, ArtifactKind>;
  notes: string[];
}

async function neededBy(entry: Export, reading: Reading): Promise<Needed> {
  const needs: ExportDependency[] = [];
  const named = new Set<string>();
  const kinds = new Map<string, ArtifactKind>();
  const notes: string[] = [];
  for (const need of entry.dependsOn) {
    if (need.type !== "local") {
      needs.push(need);
      continue;
    }
    const at = await neededAt(entry, need.path, reading);
    notes.push(...at.notes);
    for (const [root, kind] of at.roots) {
      kinds.set(root, kind);
      if (!at.folder) named.add(root);
      needs.push({ type: "local", path: posixRelative(reading.base, root) });
    }
  }
  const dependsOn = (root: string) =>
    named.has(root)
      ? needs
      : needs.filter((need) => need.type !== "local" || resolve(reading.base, need.path) !== root);
  return { dependsOn, kinds, notes };
}

async function neededAt(
  entry: Export,
  need: string,
  reading: Reading,
): Promise<Found & { folder: boolean }> {
  const path = resolve(reading.base, need);
  if (!existsSync(path)) {
    throw new AiregError(
      `Export ${quoted(entry.path)} depends on ./${need}, which names nothing in this project.`,
      { code: ErrorCode.NotFound, hint: "Check the path under its `depends_on`." },
    );
  }
  await refuseOutside(entry, artifactRoot(path), reading.base);
  const held = await heldAt(path, reading.base);
  if ("root" in held) return { roots: new Map([[held.root, held.kind]]), notes: [], folder: false };
  if (await isPlainFolder(path)) {
    const inside = await reachInside(entry, path, reading, []);
    if (inside.roots.size > 0) return { ...inside, folder: true };
    throw new AiregError(
      `Export ${quoted(entry.path)} depends on ./${need}, a folder with no skill or agent directly inside it.`,
      {
        code: ErrorCode.Invalid,
        hint:
          reading.tracked === undefined
            ? NAME_HINT
            : `${NAME_HINT} In a git repository, only what git tracks counts.`,
      },
    );
  }
  throw new AiregError(
    `Export ${quoted(entry.path)} depends on ./${need}, which is not an artifact: it ${held.stray}.`,
    { code: ErrorCode.Invalid, hint: NAME_HINT },
  );
}

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

export interface Reached {
  found: Map<string, Exported>;
  notes: string[];
  warnings: string[];
}

interface Exporting {
  kind: ArtifactKind;
  exported: Export;
}

interface Needing {
  /** Paths relative to the project. */
  dependent: string;
  needed: string;
  /** The dependent's path in `exports:`. */
  entry: string;
}

const orLeaveOut = ({ needed, entry }: Needing) =>
  `or leave ./${needed} out of the \`depends_on\` of export ${quoted(entry)}`;

function dependencyKey(need: ExportDependency): string {
  return need.type === "local" ? `./${artifactRoot(need.path)}` : formatAddress(need.ref);
}

/** Local dependencies no entry exports publish with their dependents. */
function exportNeeded(
  exports: ReadonlyMap<string, Exporting>,
  kinds: ReadonlyMap<string, ArtifactKind>,
  entries: readonly Export[],
  reading: Reading,
): Map<string, Exporting> {
  const { base } = reading;
  const added = new Map<string, Exporting>();
  for (const [root, { exported }] of exports) {
    if (exported.publish === false) continue;
    for (const need of exported.dependsOn) {
      if (need.type !== "local") continue;
      const path = resolve(base, need.path);
      const needing = { dependent: shownAt(root, base), needed: need.path, entry: exported.path };
      const other = (exports.get(path) ?? added.get(path))?.exported;
      if (other?.publish === false) throw keptHere(needing, other);
      if (other !== undefined) continue;
      refuseUnreached(needing, path, entries, reading);
      // `neededBy` read every local dependency and kept its kind.
      added.set(path, {
        kind: kinds.get(path) as ArtifactKind,
        exported: { path: need.path, version: undefined, dependsOn: [], publish: undefined },
      });
    }
  }
  return added;
}

function keptHere(needing: Needing, kept: Export): AiregError {
  const { dependent, needed } = needing;
  return new AiregError(
    `${dependent} depends on ${needed}, which export ${quoted(kept.path)} keeps here with \`publish: false\`.`,
    {
      code: ErrorCode.Invalid,
      hint: `Remove \`publish: false\` from export ${quoted(kept.path)}, ${orLeaveOut(needing)}.`,
    },
  );
}

function refuseUnreached(
  needing: Needing,
  path: string,
  entries: readonly Export[],
  reading: Reading,
): void {
  const { dependent, needed } = needing;
  const excluding = entries.find((entry) =>
    (entry.exclude ?? []).some((name) => resolve(reading.base, entry.path, name) === path),
  );
  if (excluding !== undefined) {
    throw new AiregError(
      `${dependent} depends on ${needed}, which export ${quoted(excluding.path)} leaves out with \`exclude\`.`,
      { code: ErrorCode.Invalid, hint: `Remove it from that \`exclude\`, ${orLeaveOut(needing)}.` },
    );
  }
  if (!reading.installed.has(path)) return;
  throw new AiregError(`${dependent} depends on ${needed}, which aireg installed here.`, {
    code: ErrorCode.Invalid,
    hint: "Depend on it by the address of its `artifacts:` entry instead, <registry>/<namespace>/<kind>/<name>.",
  });
}

function unmatchedPatterns(entries: readonly Export[], matched: ReadonlySet<string>): string[] {
  return entries.flatMap((entry) =>
    (entry.ignore ?? [])
      .filter((pattern) => !matched.has(ignoredBy(entry, pattern)))
      .map(
        (pattern) =>
          `Export ${quoted(entry.path)} ignores ${quoted(pattern)}, which matches no file it publishes, so it leaves nothing out.`,
      ),
  );
}
