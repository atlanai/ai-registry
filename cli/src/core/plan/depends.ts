import { isArtifactName, isNamespace } from "#adapter/filespec/names.ts";
import type { Envelope, Want } from "#adapter/index.ts";
import { type ArtifactKind, isKind } from "#adapter/kinds.ts";
import { isVersion } from "#adapter/spec/ref.ts";
import { entryFor } from "#core/catalog/catalog.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Ref } from "#core/ref.ts";
import type { Acquired, Selected } from "./model.ts";
import { addressOf } from "./select.ts";

/**
 * One `depends_on` edge. The file spec makes `to` a fully qualified ref resolved
 * within the same root, so it names one version and never another registry.
 */
export interface Need {
  namespace: string;
  kind: ArtifactKind;
  name: string;
  version: string;
}

/** A need no source listed at the version asked for. */
export interface Unresolved {
  alias: string;
  need: Need;
  /** The address of the artifact that needs it. */
  by: string;
}

/** Two requirements only one installed artifact could meet. */
export interface Conflict {
  message: string;
  hint: string;
}

export interface Closure {
  /** What the manifest's artifacts need beyond what it names, each at the version needed. */
  refs: Ref[];
  /** By the id of what is needed, the ids of what needs it. */
  neededBy: Map<string, Set<string>>;
  /** By the id of what is needed, the address of the first artifact that needs it. */
  firstBy: Map<string, string>;
  unresolved: Unresolved[];
  conflicts: Conflict[];
}

export function formatNeed(need: Need): string {
  return `${need.namespace}/${need.kind}/${need.name}@${need.version}`;
}

export function wantOf(need: Need): Want {
  return { name: need.name, namespace: need.namespace, kind: need.kind, version: need.version };
}

/** One artifact in one registry, whatever version and local name it has. */
export function idOf(alias: string, namespace: string | undefined, kind: string, name: string) {
  return `${alias}\u0000${namespace ?? ""}/${kind}/${name}`;
}

const selectedId = (item: Selected): string =>
  idOf(item.source, item.group, item.kind, item.upstreamName);

const rowId = (row: LockArtifact): string => idOf(row.registry, row.namespace, row.kind, row.name);

/** Where a selected artifact sits in its registry, as a dependency names it. */
const placeOf = (item: Selected): string =>
  addressOf({ group: item.group, kind: item.kind, name: item.upstreamName });

/** The `depends_on` edges a version declares, and the ones aireg cannot follow. */
export function needsOf(envelope: Envelope): { needs: Need[]; unusable: string[] } {
  const needs: Need[] = [];
  const unusable: string[] = [];
  const edges: unknown[] = Array.isArray(envelope.relationships) ? envelope.relationships : [];
  for (const edge of edges) {
    if (typeof edge !== "object" || edge === null) continue;
    const { rel_type: type, to } = edge as { rel_type?: unknown; to?: unknown };
    if (type !== "depends_on") continue;
    const need = typeof to === "string" ? parseNeed(to) : undefined;
    if (need === undefined) unusable.push(String(to));
    else needs.push(need);
  }
  return { needs, unusable };
}

function parseNeed(to: string): Need | undefined {
  const at = to.lastIndexOf("@");
  if (at === -1) return undefined;
  const version = to.slice(at + 1);
  const parts = to.slice(0, at).split("/");
  if (parts.length !== 3) return undefined;
  const [namespace, kind, name] = parts as [string, string, string];
  if (!isNamespace(namespace) || !isKind(kind) || !isArtifactName(name) || !isVersion(version)) {
    return undefined;
  }
  return { namespace, kind, name, version };
}

interface Visit {
  alias: string;
  id: string;
  path: string;
  address: string;
}

/**
 * Every version the selected artifacts need, transitively. Each is visited once, so a cycle ends
 * where it began, and reach is decided by the manifest's own artifacts so `remove` prunes it whole.
 */
export function closure(top: readonly Selected[], acquired: readonly Acquired[]): Closure {
  const byAlias = new Map(acquired.map((source) => [source.alias, source]));
  const topById = new Map(top.map((item) => [selectedId(item), item]));
  const chosen = new Map<string, { version: string; by: string; ref: Ref }>();
  const neededBy = new Map<string, Set<string>>();
  const unresolved: Unresolved[] = [];
  const conflicts: Conflict[] = [];
  const edge = (to: string, from: string) => {
    const set = neededBy.get(to) ?? new Set<string>();
    set.add(from);
    neededBy.set(to, set);
  };

  const queue: Visit[] = top.map((item) => ({
    alias: item.source,
    id: selectedId(item),
    path: item.path,
    address: placeOf(item),
  }));
  for (let next = 0; next < queue.length; next++) {
    const from = queue[next] as Visit;
    const source = byAlias.get(from.alias);
    for (const need of source?.placements.get(from.path)?.needs ?? []) {
      const id = idOf(from.alias, need.namespace, need.kind, need.name);
      if (id === from.id) continue;
      const wanted = `${need.namespace}/${need.kind}/${need.name}`;
      const held = topById.get(id);
      // Only an artifact the manifest names holds its version against a dependent;
      // one taken with its namespace is installed at the version it is needed at.
      if (held !== undefined && (held.version === need.version || held.named === true)) {
        if (held.version === need.version) edge(id, from.id);
        else conflicts.push(againstManifest(from.alias, wanted, need.version, from.address, held));
        continue;
      }
      const before = chosen.get(id);
      if (before !== undefined) {
        if (before.version === need.version) edge(id, from.id);
        else
          conflicts.push(betweenTwo(wanted, before, { version: need.version, by: from.address }));
        continue;
      }
      edge(id, from.id);
      const ref: Ref = { registry: from.alias, ...need };
      chosen.set(id, { version: need.version, by: from.address, ref });
      const path = publishedAt(source, need);
      if (path === undefined) unresolved.push({ alias: from.alias, need, by: from.address });
      else queue.push({ alias: from.alias, id, path, address: wanted });
    }
  }

  inheritTargets(top, neededBy, chosen);
  return {
    refs: [...chosen.values()].map((item) => item.ref),
    neededBy,
    firstBy: new Map([...chosen].map(([id, item]) => [id, item.by])),
    unresolved,
    conflicts,
  };
}

function againstManifest(
  alias: string,
  wanted: string,
  version: string,
  by: string,
  held: Selected,
): Conflict {
  return {
    message: `${by} needs ${wanted} ${version}, but the manifest installs ${held.version ?? "another version"}.`,
    hint: `Only one version can be installed here. Pin the one it needs with \`aireg add ${alias}/${wanted}@${version}\`, or remove one of them.`,
  };
}

function betweenTwo(
  wanted: string,
  first: { version: string; by: string },
  second: { version: string; by: string },
): Conflict {
  return {
    message: `${wanted} is needed at two versions: ${first.version} by ${first.by}, and ${second.version} by ${second.by}.`,
    hint: "Only one version can be installed here. Remove one of them, or ask the registry's owner to publish versions that agree.",
  };
}

/** Where the source publishes a need at exactly the version asked for. */
function publishedAt(source: Acquired | undefined, need: Need): string | undefined {
  if (source === undefined) return undefined;
  const entry = entryFor(source.catalog.entries, need.namespace, need.kind, need.name);
  if (entry === undefined) return undefined;
  return source.placements.get(entry.path)?.version === need.version ? entry.path : undefined;
}

/**
 * A dependency lands in the targets its dependents were narrowed to: the union
 * over every manifest artifact that reaches it, or the scope's own when one is not narrowed.
 */
function inheritTargets(
  top: readonly Selected[],
  neededBy: ReadonlyMap<string, ReadonlySet<string>>,
  chosen: ReadonlyMap<string, { ref: Ref }>,
): void {
  const forward = new Map<string, string[]>();
  for (const [to, froms] of neededBy) {
    for (const from of froms) forward.set(from, [...(forward.get(from) ?? []), to]);
  }
  // Undefined is the scope's targets, which nothing narrower can add to.
  const narrowed = new Map<string, readonly string[] | undefined>();
  for (const item of top) {
    for (const id of descendants(selectedId(item), forward)) {
      if (!chosen.has(id)) continue;
      const held = narrowed.has(id) ? narrowed.get(id) : [];
      narrowed.set(
        id,
        held === undefined || item.targets === undefined
          ? undefined
          : [...new Set([...held, ...item.targets])].sort(),
      );
    }
  }
  for (const [id, targets] of narrowed) {
    const ref = chosen.get(id)?.ref;
    if (ref !== undefined && targets !== undefined) ref.targets = [...targets];
  }
}

function descendants(start: string, forward: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const to of forward.get(id) ?? []) {
      if (!seen.has(to)) stack.push(to);
      seen.add(to);
    }
  }
  return seen;
}

/** By installed name, what needs each artifact, read from the closure's ids. */
export function dependentsByName(
  needs: Closure,
  selected: readonly Selected[],
  lock: Lock,
): Map<string, string[]> {
  const names = new Map<string, string>();
  for (const [name, row] of Object.entries(lock.artifacts)) names.set(rowId(row), name);
  for (const item of selected) names.set(selectedId(item), item.name);
  const byName = new Map<string, string[]>();
  for (const [id, from] of needs.neededBy) {
    const name = names.get(id);
    if (name === undefined) continue;
    const dependents = [...from].flatMap((by) => names.get(by) ?? []);
    if (dependents.length > 0) byName.set(name, [...new Set(dependents)].sort());
  }
  return byName;
}

/** A dependency that would take a name something else here already has. */
export function nameClashes(needs: Closure, selected: readonly Selected[]): Conflict[] {
  const ids = new Set(selected.map(selectedId));
  const unresolved = new Set(
    needs.unresolved.map(({ alias, need }) => idOf(alias, need.namespace, need.kind, need.name)),
  );
  return needs.refs.flatMap((ref) => {
    const id = idOf(ref.registry, ref.namespace, ref.kind ?? "", ref.name ?? "");
    const holder = selected.find((item) => item.name === ref.name);
    if (ids.has(id) || unresolved.has(id) || holder === undefined) return [];
    const wanted = `${ref.namespace}/${ref.kind}/${ref.name}`;
    return [
      {
        message: `${needs.firstBy.get(id)} needs ${wanted}, but "${holder.name}" here is ${placeOf(holder)}.`,
        hint: "Only one artifact can be installed under one name. Remove one of them.",
      },
    ];
  });
}
