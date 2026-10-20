import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ArtifactKind, PublishRelationship } from "#adapter/index.ts";
import { isLocalPath, isWithin } from "#adapter/paths.ts";
import { parseVersion } from "#adapter/semver.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import { canonicalRegistryUrl, comparableLocation } from "#core/adapter/identity.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { posixRelative } from "#core/fs/path.ts";
import { gitIn } from "#core/git.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import {
  artifactFor,
  type Export,
  type ExportDependency,
  isGlob,
  type Manifest,
  type RegistrySource,
  targetsOf,
} from "#core/manifest.ts";
import { formatAddress, type Ref } from "#core/ref.ts";
import type { Destination, Planned, Published } from "./target.ts";
import { expand, fromPath, type Work } from "./work.ts";

/** A skill is its folder, however an entry reaches it, so one path names one export. */
function artifactRoot(path: string): string {
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
      if (installed.has(root)) continue;
      if (tracked === undefined || tracked.some((file) => isWithin(path, file)))
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
    found.set(artifactRoot(path), entry);
  }
  return found;
}

/** The work `exports:` names, less what it leaves unpublished. */
export async function exportWork(found: ReadonlyMap<string, Export>): Promise<Work[]> {
  const works: Work[] = [];
  for (const [path, entry] of found) {
    if (entry.publish === false) continue;
    works.push({ ...(await fromPath(path)), exported: entry });
  }
  return works;
}

/** Whether a `publish.to` target is the destination `--to` names, as typed or as a folder. */
export function namesTarget(
  listed: string,
  to: Destination,
  /** The registry folder `--to` named, when it named one. */
  folder: string | undefined,
  base: string,
): boolean {
  if (isLocalPath(listed) !== (folder !== undefined)) return false;
  if (folder === undefined) return listed === `${to.registry}/${to.namespace}`;
  return canonical(resolve(base, listed)) === canonical(join(folder, to.namespace));
}

/** The one `publish.to` target this run sends exports to: the only one, else the one `--to` names. */
export function chooseTarget(
  listed: readonly string[],
  to: string | undefined,
  names: (target: string) => boolean,
): string {
  const options = list(
    listed.map((target) => `--to ${target}`),
    "or",
  );
  const [only] = listed;
  if (to === undefined) {
    if (listed.length === 1 && only !== undefined) return only;
    throw new AiregError(
      `The manifest lists ${plural(listed.length, "publish target")}; pass ${options}.`,
      { code: ErrorCode.Usage },
    );
  }
  const chosen = listed.find(names);
  if (chosen !== undefined) return chosen;
  throw new AiregError(`--to ${quoted(to)} is not one of the manifest's publish targets.`, {
    code: ErrorCode.Usage,
    hint: `Pass ${options}, or add it to \`publish.to\`.`,
  });
}

/** An export left out of this run, and why, as a lowercase clause. */
export interface Skipped {
  name: string;
  kind: ArtifactKind;
  reason: string;
}

/** The work that goes to `target`, and the exports whose own rules keep them from it. */
export function forTarget(
  works: readonly Work[],
  manifest: Manifest,
  /** Absent when the manifest lists no `publish.to`, so only `publish: false` keeps one back. */
  target: string | undefined,
): { works: Work[]; skipped: Skipped[] } {
  const kept: Work[] = [];
  const skipped: Skipped[] = [];
  for (const work of works) {
    const entry = work.exported;
    const reason =
      entry === undefined
        ? undefined
        : entry.publish === false
          ? "its export sets publish: false"
          : target === undefined || targetsOf(manifest, entry).includes(target)
            ? undefined
            : `its publish.to does not list ${target}`;
    if (reason === undefined) kept.push(work);
    else skipped.push({ name: work.name, kind: work.kind, reason });
  }
  return { works: kept, skipped };
}

/** The exports a local dependency names, by path, among those `found`. */
function localNeeds(entry: Export, found: ReadonlyMap<string, Export>, base: string): string[] {
  return entry.dependsOn
    .filter((need): need is Extract<ExportDependency, { type: "local" }> => need.type === "local")
    .map((need) => artifactRoot(resolve(base, need.path)))
    .filter((path) => found.has(path));
}

/**
 * The work with each export after the exports it depends on, so a dependency's version is
 * known before the edge naming it is written. A cycle among the exports is refused, naming it.
 */
export function inDependencyOrder(
  works: readonly Work[],
  found: ReadonlyMap<string, Export>,
  base: string,
): Work[] {
  if (!works.some((work) => work.exported !== undefined)) return [...works];
  const rank = new Map<string, number>();
  const visiting: string[] = [];
  const visit = (path: string): void => {
    if (rank.has(path)) return;
    const at = visiting.indexOf(path);
    if (at !== -1) {
      const cycle = [...visiting.slice(at), path].map((each) => `./${posixRelative(base, each)}`);
      throw new AiregError(`The exports depend on each other in a cycle: ${cycle.join(" → ")}.`, {
        code: ErrorCode.Invalid,
        hint: "Remove one of these `depends_on` entries.",
      });
    }
    visiting.push(path);
    for (const need of localNeeds(found.get(path) as Export, found, base)) visit(need);
    visiting.pop();
    rank.set(path, rank.size);
  };
  for (const path of found.keys()) visit(path);
  // Work that is no export keeps its place, ahead of the exports.
  const of = (work: Work) => (work.exported === undefined ? -1 : (rank.get(work.path) ?? -1));
  return [...works].sort((left, right) => of(left) - of(right));
}

/** What a dependency edge is written against: this run's target, and what it holds now. */
export interface EdgeContext {
  base: string;
  found: ReadonlyMap<string, Export>;
  manifest: Manifest;
  lock: Lock;
  /** Every registry this scope reaches, with folders as absolute paths. */
  known: Readonly<Record<string, RegistrySource>>;
  target: { registry: string; namespace: string };
  published: Published;
  /** What this run plans for an export at this path, into the same target. */
  planned: (path: string) => Promise<Planned | undefined>;
}

/** Whether two registries are one, by name or by where they are. */
function sameRegistry(context: EdgeContext, alias: string): boolean {
  if (alias === context.target.registry) return true;
  const one = context.known[alias]?.location;
  const other = context.known[context.target.registry]?.location;
  return (
    one !== undefined &&
    other !== undefined &&
    comparableLocation(one) === comparableLocation(other)
  );
}

/**
 * The `depends_on` edges an export carries into this target: another export at the version this
 * run publishes, or the target's newest, accepting that version's minor and patch releases; an
 * installed artifact at its locked version, accepting what its `artifacts:` entry does.
 */
export async function dependsOnFor(
  work: Work,
  context: EdgeContext,
): Promise<PublishRelationship[]> {
  const entry = work.exported;
  if (entry === undefined) return [];
  const edges: PublishRelationship[] = [];
  for (const need of entry.dependsOn) {
    edges.push(
      need.type === "local"
        ? await localEdge(work, entry, need.path, context)
        : remoteEdge(work, need.ref, context),
    );
  }
  return edges;
}

async function localEdge(
  work: Work,
  entry: Export,
  needed: string,
  context: EdgeContext,
): Promise<PublishRelationship> {
  const { namespace, registry } = context.target;
  const path = artifactRoot(resolve(context.base, needed));
  const other = context.found.get(path);
  if (other === undefined) {
    throw new AiregError(`${work.name} depends on ./${needed}, which is not an export.`, {
      code: ErrorCode.Invalid,
      hint: `List it under \`exports:\`, or remove it from the \`depends_on\` of export ${quoted(entry.path)}.`,
    });
  }
  const sent = await context.planned(path);
  const { name, kind } = sent?.work ?? (await fromPath(path));
  const version =
    sent?.version ?? context.published.latest.get(`${namespace}/${kind}/${name}`)?.version;
  if (version === undefined) {
    const where = `${registry}/${namespace}`;
    const shown = quoted(other.path);
    throw new AiregError(`${work.name} depends on ${name}, which is not published to ${where}.`, {
      code: ErrorCode.Invalid,
      hint:
        other.publish === false
          ? `Remove \`publish: false\` from export ${shown}, so ${name} is published with it.`
          : other.publish !== undefined
            ? `Add ${where} to the \`publish.to\` of export ${shown}, so ${name} is published with it.`
            : `Publish ${name} to ${where} in the same run, or before it.`,
    });
  }
  const range = parseVersion(version) === undefined ? {} : { range: `^${version}` };
  return { rel_type: "depends_on", to: `${namespace}/${kind}/${name}@${version}`, ...range };
}

function remoteEdge(work: Work, ref: Ref, context: EdgeContext): PublishRelationship {
  const address = formatAddress(ref);
  const row = Object.values(context.lock.artifacts).find(
    (each) =>
      each.registry === ref.registry &&
      each.namespace === ref.namespace &&
      each.kind === ref.kind &&
      each.name === ref.name,
  );
  if (row === undefined) {
    throw new AiregError(`${work.name} depends on ${address}, which is not installed.`, {
      code: ErrorCode.NotFound,
      hint: "Run `aireg install` to install it, then publish again.",
    });
  }
  const locked = row.version;
  if (locked === undefined) {
    throw new AiregError(
      `${work.name} depends on ${address}, which ${ref.registry} serves without a version, so a published artifact cannot name it.`,
      { code: ErrorCode.Invalid },
    );
  }
  // Which versions it takes is the `artifacts:` entry's to say: its range, its pin, or this one's releases.
  const listed = artifactFor(context.manifest.artifacts, ref);
  const range =
    listed?.range ??
    (listed?.version !== undefined || parseVersion(locked) === undefined
      ? undefined
      : `^${locked}`);
  let registry: string | undefined;
  if (!sameRegistry(context, ref.registry)) {
    registry = canonicalRegistryUrl(context.known[ref.registry]?.location ?? "");
    if (registry === undefined) {
      throw new AiregError(
        `${work.name} depends on ${row.name} from ${ref.registry}, which has no https address, so a published artifact cannot name it.`,
        {
          code: ErrorCode.Invalid,
          hint: `Install ${row.name} from a registry with an https address, or publish ${work.name} to ${ref.registry}.`,
        },
      );
    }
  }
  return {
    rel_type: "depends_on",
    to: `${ref.namespace}/${ref.kind}/${ref.name}@${locked}`,
    ...(range === undefined ? {} : { range }),
    ...(registry === undefined ? {} : { registry }),
  };
}
