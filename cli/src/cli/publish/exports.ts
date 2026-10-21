import { isAbsolute, join, resolve } from "node:path";
import { readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import type { ArtifactKind, PublishRelationship } from "#adapter/index.ts";
import { expandHome, isLocalPath } from "#adapter/paths.ts";
import { parseVersion } from "#adapter/semver.ts";
import { quoted } from "#adapter/text.ts";
import {
  comparableLocation,
  declaredRegistryUrl,
  reportedRegistryUrl,
} from "#core/adapter/identity.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { posixRelative } from "#core/fs/path.ts";
import type { Lock } from "#core/lock.ts";
import {
  artifactFor,
  type Export,
  type ExportDependency,
  type Manifest,
  type RegistrySource,
} from "#core/manifest.ts";
import { formatAddress, type Ref } from "#core/ref.ts";
import { artifactRoot } from "./reach.ts";
import type { Destination, Planned, Published } from "./target.ts";
import { fromPath, type Work } from "./work.ts";

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

/** Exports go to the manifest's one `publish.to` target, so a `--to` naming another is refused. */
export function chooseTarget(
  target: string,
  to: string | undefined,
  names: (target: string) => boolean,
): string {
  if (to === undefined || names(target)) return target;
  throw new AiregError(`--to ${quoted(to)} is not the manifest's publish target, ${target}.`, {
    code: ErrorCode.Usage,
    hint: `Leave \`--to\` off to publish to ${target}, or change \`publish.to\`.`,
  });
}

/** An export left out of this run, and why, as a lowercase clause. */
export interface Skipped {
  name: string;
  kind: ArtifactKind;
  reason: string;
}

/** The work that goes to the target, and the exports that set `publish: false` to stay here. */
export function forTarget(works: readonly Work[]): { works: Work[]; skipped: Skipped[] } {
  const kept: Work[] = [];
  const skipped: Skipped[] = [];
  for (const work of works) {
    if (work.exported?.publish !== false) kept.push(work);
    else
      skipped.push({ name: work.name, kind: work.kind, reason: "its export sets publish: false" });
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
  return one !== undefined && other !== undefined && placeOf(one) === placeOf(other);
}

/** A folder by its resolved path, which a trailing separator or a drive letter cannot split; any other address as compared. */
function placeOf(location: string): string {
  return isAbsolute(location) ? resolve(location) : comparableLocation(location);
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
        : await remoteEdge(work, need.ref, context),
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
          : `Publish ${name} to ${where} in the same run, or before it.`,
    });
  }
  const range = parseVersion(version) === undefined ? {} : { range: `^${version}` };
  return { rel_type: "depends_on", to: `${namespace}/${kind}/${name}@${version}`, ...range };
}

/**
 * The `https` URL its `registry.json` names, for a registry in a folder: what a consumer that
 * declares the folder matches an edge by, read from disk so publishing reaches no other host.
 * Undefined for any other address, or a folder that is no registry.
 */
async function folderUrl(location: string): Promise<string | undefined> {
  if (!isLocalPath(location)) return undefined;
  try {
    return reportedRegistryUrl((await readRegistry(rootReader(expandHome(location)))).url);
  } catch {
    return undefined;
  }
}

async function remoteEdge(
  work: Work,
  ref: Ref,
  context: EdgeContext,
): Promise<PublishRelationship> {
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
    // The URL a consumer matches the edge by (`declaredRegistryUrl`), so the two never disagree.
    const location = context.known[ref.registry]?.location ?? "";
    registry = declaredRegistryUrl(location, await folderUrl(location));
    if (registry === undefined) {
      throw new AiregError(
        `${work.name} depends on ${row.name} from ${ref.registry}, which has no https address, so a published artifact cannot name it.`,
        {
          code: ErrorCode.Invalid,
          hint: `Give ${ref.registry}'s registry.json an https \`url\`, install ${row.name} from a registry with an https address, or publish ${work.name} to ${ref.registry}.`,
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
