import { isArtifactName, isNamespace, isVersion } from "#adapter/filespec/names.ts";
import type { Envelope, Want } from "#adapter/index.ts";
import {
  formatRange,
  intersect,
  parseRange,
  parseVersion,
  type Range,
  satisfies,
} from "#adapter/semver.ts";
import { entryFor } from "#core/catalog/model.ts";
import { dict } from "#core/fields.ts";
import { type ArtifactKind, isKind } from "#core/kinds.ts";
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
  /** The version `to` names, which `range` admits. */
  version: string;
  /** The versions the edge accepts. Absent, it accepts `version` only. */
  range?: string | undefined;
}

/** A need no source listed at a version it accepts. */
export interface Unresolved {
  alias: string;
  /** What to ask for: every dependent's range ANDed, or the one version they all accept. */
  need: Need;
  /** The address of the artifact that needs it. */
  by: string;
  /** Each range or version asked for and who asked, when more than one edge with a range did. */
  needed?: { at: string; by: string }[] | undefined;
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
  /**
   * By the id of an artifact with an edge that carries a range, what each edge asks of the id it
   * needs: the range, or the version an edge without one names.
   */
  dependsOn: Map<string, Map<string, string>>;
  /** By the id of what is needed, the address of the first artifact that needs it. */
  firstBy: Map<string, string>;
  unresolved: Unresolved[];
  conflicts: Conflict[];
}

export function formatNeed(need: Need): string {
  return `${need.namespace}/${need.kind}/${need.name}@${need.range ?? need.version}`;
}

export function wantOf(need: Need): Want {
  const { name, namespace, kind } = need;
  return need.range === undefined
    ? { name, namespace, kind, version: need.version }
    : { name, namespace, kind, range: need.range };
}

/** Whether a version is one the need accepts: in its range, or the very version it names. */
export function accepts(need: Need, version: string | undefined): boolean {
  if (version === undefined) return false;
  return need.range === undefined ? version === need.version : satisfies(version, need.range);
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

/** An edge aireg cannot follow: its `to`, and the range it carries when that is what is wrong. */
export interface Unusable {
  to: string;
  range?: string | undefined;
}

/** The `depends_on` edges a version declares, and the ones aireg cannot follow. */
export function needsOf(envelope: Envelope): { needs: Need[]; unusable: Unusable[] } {
  const needs: Need[] = [];
  const unusable: Unusable[] = [];
  const edges: unknown[] = Array.isArray(envelope.relationships) ? envelope.relationships : [];
  for (const edge of edges) {
    if (typeof edge !== "object" || edge === null) continue;
    const {
      rel_type: type,
      to,
      range,
    } = edge as { rel_type?: unknown; to?: unknown; range?: unknown };
    if (type !== "depends_on") continue;
    const need = typeof to === "string" ? parseNeed(to) : undefined;
    if (need === undefined) {
      unusable.push({ to: String(to) });
    } else if (range === undefined) {
      needs.push(need);
    } else if (typeof range === "string" && satisfies(need.version, range)) {
      // A range its own `to` is outside of says nothing a reader can trust (section 3.4).
      needs.push({ ...need, range });
    } else {
      unusable.push({ to: String(to), range: String(range) });
    }
  }
  return { needs, unusable };
}

interface Visit {
  alias: string;
  id: string;
  /** Where the source lists it; undefined for a dependency until it is read, when its version is known. */
  path: string | undefined;
  address: string;
}

/** What one dependent's edge asks of what it needs, and who that dependent is. */
interface Constraint {
  need: Need;
  /** The dependent's address. */
  by: string;
  /** The dependent's id. */
  from: string;
}

/** A dependency the closure takes, with every edge that asks for it. */
interface Chosen {
  alias: string;
  /** Its `<namespace>/<kind>/<name>`. */
  wanted: string;
  ref: Ref;
  constraints: Constraint[];
  /** The id of the artifact whose edge first reached it. */
  parent: string;
  /** Whether its own edges were followed, at the version the source lists. */
  read: boolean;
}

/** The version the source lists a dependency at, and where. */
function listedAt(
  source: Acquired | undefined,
  need: Pick<Need, "namespace" | "kind" | "name">,
): { path: string; version: string | undefined } | undefined {
  if (source === undefined) return undefined;
  const entry = entryFor(source.catalog.entries, need.namespace, need.kind, need.name);
  if (entry === undefined) return undefined;
  return { path: entry.path, version: source.placements.get(entry.path)?.version };
}

const acceptedBy = (constraints: readonly Constraint[], version: string | undefined) =>
  constraints.every(({ need }) => accepts(need, version));

/** What a closure has gathered so far, as it reads one artifact's edges after another. */
interface Walk {
  byAlias: ReadonlyMap<string, Acquired>;
  topById: ReadonlyMap<string, Selected>;
  chosen: Map<string, Chosen>;
  neededBy: Map<string, Set<string>>;
  dependsOn: Map<string, Map<string, string>>;
  /** The ids with an edge that carries a range, whose edges the lockfile records. */
  ranged: Set<string>;
  /** Each with the id whose edges raised it, so one raised by edges read at a stale version is dropped. */
  raised: { conflict: Conflict; from: string }[];
  queue: Visit[];
}

function edge(walk: Walk, to: string, from: string, need: Need): void {
  const set = walk.neededBy.get(to) ?? new Set<string>();
  set.add(from);
  walk.neededBy.set(to, set);
  const asks = walk.dependsOn.get(from) ?? new Map<string, string>();
  if (!asks.has(to)) asks.set(to, need.range ?? need.version);
  walk.dependsOn.set(from, asks);
  if (need.range !== undefined) walk.ranged.add(from);
}

/** Where to read a visit's edges: a dependency only at a version every edge seen so far accepts. */
function pathOf(walk: Walk, from: Visit): string | undefined {
  if (from.path !== undefined) return from.path;
  const item = walk.chosen.get(from.id) as Chosen;
  const listed = listedAt(walk.byAlias.get(from.alias), item.constraints[0]?.need as Need);
  if (listed === undefined || !acceptedBy(item.constraints, listed.version)) return undefined;
  item.read = true;
  return listed.path;
}

/** One edge of `from`, taken against what the manifest names and what other edges asked. */
function reach(walk: Walk, from: Visit, need: Need): void {
  const id = idOf(from.alias, need.namespace, need.kind, need.name);
  if (id === from.id) return;
  const wanted = `${need.namespace}/${need.kind}/${need.name}`;
  const held = walk.topById.get(id);
  // Only an artifact the manifest names holds its version against a dependent;
  // one taken with its namespace is installed at the version it is needed at.
  if (held !== undefined && (accepts(need, held.version) || held.named === true)) {
    if (accepts(need, held.version)) edge(walk, id, from.id, need);
    else {
      const conflict = againstManifest(from.alias, wanted, need, from.address, held);
      walk.raised.push({ conflict, from: from.id });
    }
    return;
  }
  const constraint = { need, by: from.address, from: from.id };
  const before = walk.chosen.get(id);
  if (before !== undefined) {
    const [first] = before.constraints as [Constraint];
    const exact = need.range === undefined && before.constraints.every((c) => !c.need.range);
    // Two edges without a range name one version each, and only one can install.
    if (exact && first.need.version !== need.version) {
      const conflict = betweenTwo(
        wanted,
        { version: first.need.version, by: first.by },
        { version: need.version, by: from.address },
      );
      walk.raised.push({ conflict, from: from.id });
      return;
    }
    edge(walk, id, from.id, need);
    before.constraints.push(constraint);
    return;
  }
  edge(walk, id, from.id, need);
  const ref: Ref = { registry: from.alias, ...need };
  const chosen = { alias: from.alias, wanted, ref, constraints: [constraint], parent: from.id };
  walk.chosen.set(id, { ...chosen, read: false });
  walk.queue.push({ alias: from.alias, id, path: undefined, address: wanted });
}

/**
 * Every version the selected artifacts need, transitively. Each is visited once, so a cycle ends
 * where it began, and reach is decided by the manifest's own artifacts so `remove` prunes it whole.
 * A dependency several edges reach is read at a version every one of them accepts; when the source
 * lists one they do not, it is unresolved, asked for at the range they all admit.
 */
export function closure(top: readonly Selected[], acquired: readonly Acquired[]): Closure {
  const walk: Walk = {
    byAlias: new Map(acquired.map((source) => [source.alias, source])),
    topById: new Map(top.map((item) => [selectedId(item), item])),
    chosen: new Map(),
    neededBy: new Map(),
    dependsOn: new Map(),
    ranged: new Set(),
    raised: [],
    queue: top.map((item) => ({
      alias: item.source,
      id: selectedId(item),
      path: item.path,
      address: placeOf(item),
    })),
  };
  for (let next = 0; next < walk.queue.length; next++) {
    const from = walk.queue[next] as Visit;
    const path = pathOf(walk, from);
    if (path === undefined) continue;
    const source = walk.byAlias.get(from.alias);
    for (const need of source?.placements.get(path)?.needs ?? []) reach(walk, from, need);
  }

  const { chosen, neededBy, dependsOn } = walk;
  const { unresolved, conflicts } = settle(chosen, walk.byAlias, walk.raised);
  inheritTargets(top, neededBy, chosen);
  return {
    refs: [...chosen.values()].map((item) => item.ref),
    neededBy,
    dependsOn: new Map([...dependsOn].filter(([from]) => walk.ranged.has(from))),
    firstBy: new Map([...chosen].map(([id, item]) => [id, item.constraints[0]?.by as string])),
    unresolved,
    conflicts,
  };
}

/**
 * What the closure could not settle from what the sources listed. A dependency read at a version
 * an edge found later does not accept is stale, and so is everything its edges raised: those are
 * dropped, as the next read, at a version every edge accepts, raises them again if they hold.
 */
function settle(
  chosen: ReadonlyMap<string, Chosen>,
  byAlias: ReadonlyMap<string, Acquired>,
  raised: readonly { conflict: Conflict; from: string }[],
): { unresolved: Unresolved[]; conflicts: Conflict[] } {
  const versionOf = (item: Chosen) =>
    listedAt(byAlias.get(item.alias), item.constraints[0]?.need as Need)?.version;
  const stale = new Set(
    [...chosen]
      .filter(([, item]) => item.read && !acceptedBy(item.constraints, versionOf(item)))
      .map(([id]) => id),
  );
  const fresh = (id: string): boolean => {
    for (let at: string | undefined = id; at !== undefined; at = chosen.get(at)?.parent) {
      if (stale.has(at)) return false;
    }
    return true;
  };

  const unresolved: Unresolved[] = [];
  const conflicts = raised.filter(({ from }) => fresh(from)).map(({ conflict }) => conflict);
  for (const item of chosen.values()) {
    const version = versionOf(item);
    if (acceptedBy(item.constraints, version)) continue;
    const kept = item.constraints.filter(({ from }) => fresh(from));
    if (kept.length === 0) continue;
    // What its fresh edges accept may be the stale version; asking again for that would loop.
    const asked = acceptedBy(kept, version) ? item.constraints : kept;
    const met = meeting(item.wanted, asked);
    if ("message" in met) {
      conflicts.push(met);
      continue;
    }
    const withRanges = asked.length > 1 && asked.some(({ need }) => need.range !== undefined);
    unresolved.push({
      alias: item.alias,
      need: met,
      by: asked[0]?.by as string,
      ...(withRanges
        ? { needed: asked.map(({ need, by }) => ({ at: need.range ?? need.version, by })) }
        : {}),
    });
  }
  return { unresolved, conflicts };
}

/** The one need every constraint's version meets, or the conflict that says none can. */
function meeting(wanted: string, constraints: readonly Constraint[]): Need | Conflict {
  const first = constraints[0]?.need as Need;
  const exact = [...new Set(constraints.flatMap(({ need }) => (need.range ? [] : [need.version])))];
  const ranges = [
    ...new Set(constraints.flatMap(({ need }) => (need.range === undefined ? [] : [need.range]))),
  ];
  if (exact.length === 1) {
    const version = exact[0] as string;
    const { namespace, kind, name } = first;
    return ranges.every((range) => satisfies(version, range))
      ? { namespace, kind, name, version }
      : noOverlap(wanted, constraints);
  }
  if (exact.length > 1) return noOverlap(wanted, constraints);
  if (ranges.length === 1) return first;
  const met = intersect(ranges.map((range) => parseRange(range) as Range));
  return met === undefined ? noOverlap(wanted, constraints) : { ...first, range: formatRange(met) };
}

/**
 * The range a dependency moves within when an update moves it: what every dependent's recorded
 * edge admits, when each recorded one and none named a version alone. Undefined holds it.
 */
export function movesWithin(lock: Lock, name: string): string | undefined {
  const row = lock.artifacts[name];
  if (row?.neededBy === undefined) return undefined;
  const asked = row.neededBy.map((by) => lock.artifacts[by]?.dependsOn?.[name]);
  const ranges = asked.map((at) =>
    at === undefined || parseVersion(at) !== undefined ? undefined : parseRange(at),
  );
  if (ranges.some((range) => range === undefined)) return undefined;
  if (asked.length === 1) return asked[0];
  const met = intersect(ranges as Range[]);
  return met === undefined ? undefined : formatRange(met);
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

/** By installed name, what each artifact with a ranged edge asks of what it needs, by that one's installed name. */
export function dependenciesByName(
  needs: Closure,
  selected: readonly Selected[],
  lock: Lock,
): Map<string, Record<string, string>> {
  const names = new Map<string, string>();
  for (const [name, row] of Object.entries(lock.artifacts)) names.set(rowId(row), name);
  for (const item of selected) names.set(selectedId(item), item.name);
  const byName = new Map<string, Record<string, string>>();
  for (const [from, asks] of needs.dependsOn) {
    const name = names.get(from);
    if (name === undefined) continue;
    const named = [...asks].flatMap(([to, at]) => {
      const dependency = names.get(to);
      return dependency === undefined ? [] : [[dependency, at] as const];
    });
    if (named.length > 0) byName.set(name, dict(named.sort(([a], [b]) => (a < b ? -1 : 1))));
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

/** Everything reachable from one artifact along its edges. */
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

/**
 * A dependency lands in the harnesses its dependents were narrowed to: the union
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
  // Undefined is the scope's harnesses, which nothing narrower can add to.
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

function againstManifest(
  alias: string,
  wanted: string,
  need: Need,
  by: string,
  held: Selected,
): Conflict {
  return {
    message: `${by} needs ${wanted} ${need.range ?? need.version}, but the manifest installs ${held.version ?? "another version"}.`,
    hint: `Only one version can be installed here. Pin the one it needs with \`aireg add ${alias}/${wanted}@${need.version}\`, or remove one of them.`,
  };
}

/** `a by x, b by y, and c by z`, each once, in the order the edges were read. */
function askedBy(constraints: readonly { at: string; by: string }[]): string {
  const items = [...new Set(constraints.map(({ at, by }) => `${at} by ${by}`))];
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const AGREE_HINT =
  "Only one version can be installed here. Remove one of them, or ask the registry's owner to publish versions that agree.";

function noOverlap(wanted: string, constraints: readonly Constraint[]): Conflict {
  const asked = constraints.map(({ need, by }) => ({ at: need.range ?? need.version, by }));
  return {
    message: `${wanted} is needed at versions that do not overlap: ${askedBy(asked)}.`,
    hint: AGREE_HINT,
  };
}

/** Edges whose ranges overlap, where the registry publishes no version in all of them. */
export function unmet(alias: string, missing: Unresolved): Conflict | undefined {
  if (missing.needed === undefined) return undefined;
  const { namespace, kind, name } = missing.need;
  return {
    message: `${namespace}/${kind}/${name} is needed at ${askedBy(missing.needed)}, and ${alias} publishes no version that satisfies all of them.`,
    hint: "Ask the registry's owner to publish one, or remove one of them.",
  };
}

function betweenTwo(
  wanted: string,
  first: { version: string; by: string },
  second: { version: string; by: string },
): Conflict {
  return {
    message: `${wanted} is needed at two versions: ${first.version} by ${first.by}, and ${second.version} by ${second.by}.`,
    hint: AGREE_HINT,
  };
}
