import { isAbsolute, join, resolve } from "node:path";
import { readRegistry } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import type { ArtifactKind, PublishRelationship, SourceAdapter, Want } from "#adapter/index.ts";
import { expandHome, isLocalPath } from "#adapter/paths.ts";
import { parseVersion } from "#adapter/semver.ts";
import { plural, quoted } from "#adapter/text.ts";
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

/**
 * The work `exports:` names, less what it leaves unpublished. Two exports of one kind and name
 * would be two versions of one artifact, written over each other, so they are refused.
 */
export async function exportWork(
  found: ReadonlyMap<string, Export>,
  base: string,
): Promise<Work[]> {
  const works: Work[] = [];
  const seen = new Map<string, Work>();
  for (const [path, entry] of found) {
    if (entry.publish === false) continue;
    const work: Work = { ...(await fromPath(path)), exported: entry };
    const key = `${work.kind}/${work.name}`;
    const other = seen.get(key);
    if (other !== undefined) {
      const [one, two] = [other, work].map((each) => posixRelative(base, each.path) || ".");
      throw new AiregError(`${one} and ${two} are both exported as ${work.kind} ${work.name}.`, {
        code: ErrorCode.Invalid,
        hint: "Give one of them another `name` in its front matter, or leave it out of `exports:`.",
      });
    }
    seen.set(key, work);
    works.push(work);
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
  /** Where it is, relative to the project. */
  path: string;
  reason: string;
}

const skip = (work: Work, base: string, reason: string): Skipped => ({
  name: work.name,
  kind: work.kind,
  path: posixRelative(base, work.path) || ".",
  reason,
});

/** The work that goes to the target, and the exports that set `publish: false` to stay here. */
export function forTarget(
  works: readonly Work[],
  base: string,
): { works: Work[]; skipped: Skipped[] } {
  const kept: Work[] = [];
  const skipped: Skipped[] = [];
  for (const work of works) {
    if (work.exported?.publish !== false) kept.push(work);
    else skipped.push(skip(work, base, "its export sets publish: false"));
  }
  return { works: kept, skipped };
}

/**
 * Why the registry an export goes to does not take it, as a lowercase clause, or undefined when
 * it does: its adapter publishes only some kinds, and keeps no agent's files beyond its AGENT.md
 * unless it declares `agentFolders`.
 */
function untaken(work: Work, adapter: SourceAdapter, alias: string): string | undefined {
  if (work.exported === undefined) return undefined;
  const kinds = adapter.publishKinds ?? adapter.artifactKinds;
  if (!kinds.includes(work.kind)) return `${alias} does not take ${work.kind}s`;
  const files = work.exported.files?.length ?? 1;
  if (work.kind !== "agent" || files <= 1 || adapter.capabilities.agentFolders === true) {
    return undefined;
  }
  return `${alias} keeps no agent's files beyond its AGENT.md, and it has ${plural(files - 1, "more file")}`;
}

/** The work its registry takes, the exports it does not, and a warning for each edge left out. */
export interface Taken {
  works: Work[];
  skipped: Skipped[];
  /** The exports left out, by path, so an edge to one is left out too. */
  left: Set<string>;
  warnings: string[];
}

/**
 * An export the registry it goes to does not take is left out, not failed, so the rest still
 * publish; an export depending on it publishes without that edge, and says so.
 */
export async function takenBy(
  works: readonly Work[],
  registryOf: (work: Work) => Promise<{ alias: string; adapter: SourceAdapter }>,
  found: ReadonlyMap<string, Export> | undefined,
  base: string,
): Promise<Taken> {
  const taken: Taken = { works: [], skipped: [], left: new Set(), warnings: [] };
  const why = new Map<string, { name: string; reason: string }>();
  for (const work of works) {
    const { alias, adapter } = await registryOf(work);
    const reason = untaken(work, adapter, alias);
    if (reason === undefined) {
      taken.works.push(work);
      continue;
    }
    taken.skipped.push(skip(work, base, reason));
    taken.left.add(work.path);
    why.set(work.path, { name: work.name, reason });
  }
  for (const work of taken.works) {
    if (work.exported === undefined || found === undefined) continue;
    for (const need of localNeeds(work.exported, found, base)) {
      const left = why.get(need);
      if (left === undefined) continue;
      taken.warnings.push(
        `Left out the dependency of ${work.name} on ${left.name}, since ${left.reason}.`,
      );
    }
  }
  return taken;
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
  /** The exports this run leaves out because their registry does not take them, by path. */
  left?: ReadonlySet<string> | undefined;
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
 * installed artifact at its locked version, accepting what its `artifacts:` entry does. None to an
 * export this run leaves out because its registry does not take it.
 */
export async function dependsOnFor(
  work: Work,
  context: EdgeContext,
): Promise<PublishRelationship[]> {
  const entry = work.exported;
  if (entry === undefined) return [];
  const edges: PublishRelationship[] = [];
  for (const need of entry.dependsOn) {
    const edge =
      need.type === "local"
        ? await localEdge(work, need.path, context)
        : await remoteEdge(work, need.ref, context);
    if (edge !== undefined) edges.push(edge);
  }
  return edges;
}

/**
 * What a publish asks each registry for, by its alias: each artifact it may publish there, and each
 * export a local dependency names, whose version an edge takes. No want names a version, so none pins.
 */
export async function publishWants(
  works: readonly Work[],
  where: ReadonlyMap<Work, { registry: string; namespace: string }>,
  base: string,
): Promise<Map<string, Want[]>> {
  const wants = new Map<string, Map<string, Want>>();
  const ask = (registry: string, want: Want) => {
    const into = wants.get(registry) ?? new Map<string, Want>();
    into.set(`${want.namespace}/${want.kind}/${want.name}`, want);
    wants.set(registry, into);
  };
  for (const work of works) {
    const target = where.get(work);
    if (target === undefined) continue;
    const { registry, namespace } = target;
    ask(registry, { name: work.name, namespace, kind: work.kind });
    for (const need of work.exported?.dependsOn ?? []) {
      if (need.type !== "local") continue;
      const path = artifactRoot(resolve(base, need.path));
      const { name, kind } = works.find((each) => each.path === path) ?? (await fromPath(path));
      ask(registry, { name, namespace, kind });
    }
  }
  return new Map([...wants].map(([registry, into]) => [registry, [...into.values()]]));
}

async function localEdge(
  work: Work,
  needed: string,
  context: EdgeContext,
): Promise<PublishRelationship | undefined> {
  const { namespace, registry } = context.target;
  // `exportsOn` exports every artifact a local dependency names, so each one is an export.
  const path = artifactRoot(resolve(context.base, needed));
  // Left out because its registry does not take it, so its dependents go without the edge.
  if (context.left?.has(path) === true) return undefined;
  const sent = await context.planned(path);
  const { name, kind } = sent?.work ?? (await fromPath(path));
  const version =
    sent?.version ?? context.published.latest.get(`${namespace}/${kind}/${name}`)?.version;
  if (version === undefined) {
    const where = `${registry}/${namespace}`;
    throw new AiregError(`${work.name} depends on ${name}, which is not published to ${where}.`, {
      code: ErrorCode.Invalid,
      hint: `Publish ${name} to ${where} in the same run, or before it.`,
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
