import { isAbsolute, join, resolve } from "node:path";
import type { ArtifactKind, PublishRelationship, SourceAdapter, Want } from "#adapter/index.ts";
import { isBuiltinKind } from "#adapter/kinds.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { plural, quoted } from "#adapter/text.ts";
import { comparableLocation, sourceKey } from "#core/adapter/identity.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { posixRelative } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { kindPlural } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import { artifactFor } from "#core/manifest/match.ts";
import type { Export, ExportDependency, Manifest, RegistrySource } from "#core/manifest/model.ts";
import { formatAddress, type Ref } from "#core/ref.ts";
import { artifactRoot } from "./reach.ts";
import { artifactKey, type Destination, type Planned, type Published } from "./target.ts";
import { declaredWork, fromPath, type Work } from "./work.ts";

/** Rejects duplicate kind/name identities. */
export async function exportWork(
  found: ReadonlyMap<string, Export>,
  base: string,
): Promise<Work[]> {
  const works: Work[] = [];
  const seen = new Map<string, Work>();
  for (const [path, entry] of found) {
    if (entry.publish === false) continue;
    const declared = entry.kind !== undefined && !isBuiltinKind(entry.kind);
    const read = declared ? await declaredWork(path, entry.kind as string) : await fromPath(path);
    const work: Work = { ...read, exported: entry };
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

export function namesTarget(
  listed: string,
  to: Destination,
  folder: string | undefined,
  base: string,
): boolean {
  if (isLocalPath(listed) !== (folder !== undefined)) return false;
  if (folder === undefined) return listed === `${to.registry}/${to.namespace}`;
  return canonical(resolve(base, listed)) === canonical(join(folder, to.namespace));
}

/** Exports go to the manifest's one `publish.to` target, so `--to` naming another is refused. */
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

/** The reason is a lowercase clause. */
export interface Skipped {
  name: string;
  kind: ArtifactKind;
  /** Relative to the project. */
  path: string;
  reason: string;
}

const skip = (work: Work, base: string, reason: string): Skipped => ({
  name: work.name,
  kind: work.kind,
  path: posixRelative(base, work.path) || ".",
  reason,
});

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

export interface Taken {
  works: Work[];
  skipped: Skipped[];
  /** By path, so an edge to one is left out too. */
  left: Set<string>;
  warnings: string[];
}

function untaken(work: Work, adapter: SourceAdapter, alias: string): string | undefined {
  if (work.exported === undefined) return undefined;
  const kinds = adapter.publishKinds ?? adapter.artifactKinds;
  if (!kinds.includes(work.kind)) return `${alias} does not take ${kindPlural(work.kind)}`;
  const files = work.exported.files?.length ?? 1;
  if (work.kind !== "agent" || files <= 1 || adapter.capabilities.agentFolders === true) {
    return undefined;
  }
  return `${alias} keeps no agent's files beyond its AGENT.md, and it has ${plural(files - 1, "more file")}`;
}

function localNeeds(entry: Export, found: ReadonlyMap<string, Export>, base: string): string[] {
  return entry.dependsOn
    .filter((need): need is Extract<ExportDependency, { type: "local" }> => need.type === "local")
    .map((need) => artifactRoot(resolve(base, need.path)))
    .filter((path) => found.has(path));
}

/** Rejects cycles. */
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

  const of = (work: Work) => (work.exported === undefined ? -1 : (rank.get(work.path) ?? -1));
  return [...works].sort((left, right) => of(left) - of(right));
}

export interface EdgeContext {
  base: string;
  /** Exports their registry does not take, by path. */
  left?: ReadonlySet<string> | undefined;
  manifest: Manifest;
  lock: Lock;
  /** Folders as absolute paths. */
  known: Readonly<Record<string, RegistrySource>>;
  target: { registry: string; namespace: string };
  published: Published;
  planned: (path: string) => Promise<Planned | undefined>;
}

/** Resolves local exports and installed artifacts to exact release labels. */
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

async function localEdge(
  work: Work,
  needed: string,
  context: EdgeContext,
): Promise<PublishRelationship | undefined> {
  const { namespace, registry } = context.target;

  const path = artifactRoot(resolve(context.base, needed));
  // Its registry does not take it, so its dependents go without the edge.
  if (context.left?.has(path) === true) return undefined;
  const sent = await context.planned(path);
  const { name, kind } = sent?.work ?? (await fromPath(path));
  const version =
    sent?.version ?? context.published.latest.get(artifactKey(namespace, kind, name))?.version;
  if (version === undefined) {
    const where = `${registry}/${namespace}`;
    throw new AiregError(`${work.name} depends on ${name}, which is not published to ${where}.`, {
      code: ErrorCode.Invalid,
      hint: `Publish ${name} to ${where} in the same run, or before it.`,
    });
  }
  return { rel_type: "depends_on", to: `${namespace}/${kind}/${name}@${version}` };
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
  const pinned = artifactFor(context.manifest.artifacts, ref)?.version;
  if (pinned !== undefined && pinned !== locked) {
    throw new AiregError(
      `${work.name} depends on ${address}@${pinned}, but ${locked} is installed.`,
      {
        code: ErrorCode.Changed,
        hint: "Run `aireg install` to install the declared version, then publish again.",
      },
    );
  }
  if (!sameRegistry(context, ref.registry)) {
    throw new AiregError(`${work.name} depends on ${address} from another registry.`, {
      code: ErrorCode.Invalid,
      hint: "Publish the dependency to this registry and install it from there first.",
    });
  }
  return { rel_type: "depends_on", to: `${ref.namespace}/${ref.kind}/${ref.name}@${locked}` };
}

function sameRegistry(context: EdgeContext, alias: string): boolean {
  if (alias === context.target.registry) return true;
  const one = context.known[alias];
  const other = context.known[context.target.registry];
  return (
    one !== undefined &&
    other !== undefined &&
    one.adapter === other.adapter &&
    sourceKey(placeOf(one.location), one.config) ===
      sourceKey(placeOf(other.location), other.config)
  );
}

function placeOf(location: string): string {
  return isAbsolute(location) ? resolve(location) : comparableLocation(location);
}

/** By name, without version pins. */
export async function publishWants(
  works: readonly Work[],
  where: ReadonlyMap<Work, { registry: string; namespace: string }>,
  base: string,
): Promise<Map<string, Want[]>> {
  const wants = new Map<string, Map<string, Want>>();
  const ask = (registry: string, want: { name: string; namespace: string; kind: ArtifactKind }) => {
    const into = wants.get(registry) ?? new Map<string, Want>();
    into.set(artifactKey(want.namespace, want.kind, want.name), want);
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
