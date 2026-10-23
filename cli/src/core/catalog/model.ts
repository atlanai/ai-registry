import type { ArtifactKind } from "#core/kinds.ts";
import type { Newest, Withheld } from "./withheld.ts";

/** Where an entry was read from. */
interface Provenance {
  /** A registry-relative file, or the id of the adapter that listed the entry. */
  file: string;
  /** A JSON pointer within that file, or the artifact's id in that adapter; empty for a whole file. */
  pointer: string;
}

export interface Entry {
  /** Sanitized; the name the artifact is addressed and installed by. */
  name: string;
  kind: ArtifactKind;
  /** Registry-relative, POSIX separators, always inside the root. */
  path: string;
  /** Owning plugin, when this entry came from one. */
  group: string | undefined;
  /** Already stripped of control sequences at read time. */
  description: string | undefined;
  /** Oldest aireg CLI that can install this artifact. Plain SemVer, meaning >=. */
  engine: string | undefined;
  from: Provenance;
}

export interface Catalog {
  root: string;
  /** Which readers produced entries, in the order they ran, as `registry show` reports them. */
  layouts: string[];
  /** Sorted by name, deduplicated. */
  entries: Entry[];
  warnings: string[];
  /** What the registry reached but would not serve by status, so a copy of it is kept. */
  withheld?: Withheld[];
  /** The adapter read the listing to its end, so what it leaves out was deleted. */
  complete?: boolean;
  /** Each artifact's newest version where the registry served another, so a publish goes past it. */
  newest?: Newest[];
}

export function emptyCatalog(root: string): Catalog {
  return { root, layouts: [], entries: [], warnings: [] };
}

/** Identity includes the namespace: two organizations publishing a `lint` are two artifacts. */
function identity(entry: Pick<Entry, "group" | "kind" | "name">): string {
  return `${entry.group ?? ""}\u0000${entry.kind}:${entry.name}`;
}

/** First writer wins, so an entry listed twice under one identity is kept once. */
export function merge(catalog: Catalog, layout: string, entries: Entry[]): void {
  if (entries.length === 0) return;
  if (!catalog.layouts.includes(layout)) catalog.layouts.push(layout);
  const seen = new Set(catalog.entries.map(identity));
  for (const entry of entries) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    catalog.entries.push(entry);
  }
}

export function finalize(catalog: Catalog): Catalog {
  catalog.entries.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  return catalog;
}

/**
 * Installing a plugin already places everything inside it, so its own leaves
 * must not be projected a second time under their own names.
 */
export function withoutCoveredLeaves(entries: readonly Entry[]): Entry[] {
  const plugins = new Set(entries.filter((e) => e.kind === "plugin").map((e) => e.name));
  return entries.filter(
    (e) => e.kind === "plugin" || e.group === undefined || !plugins.has(e.group),
  );
}

interface Index {
  size: number;
  byIdentity: Map<string, Entry>;
  byName: Map<string, Entry[]>;
  byGroup: Map<string, Entry[]>;
}

/** Built once per entry list and rebuilt only if it grew, so a lookup per artifact stays linear overall. */
const INDEXES = new WeakMap<readonly Entry[], Index>();

function indexOf(entries: readonly Entry[]): Index {
  const kept = INDEXES.get(entries);
  if (kept !== undefined && kept.size === entries.length) return kept;
  const index: Index = {
    size: entries.length,
    byIdentity: new Map(),
    byName: new Map(),
    byGroup: new Map(),
  };
  for (const entry of entries) {
    index.byIdentity.set(identity(entry), entry);
    index.byName.set(entry.name, [...(index.byName.get(entry.name) ?? []), entry]);
    if (entry.group !== undefined) {
      index.byGroup.set(entry.group, [...(index.byGroup.get(entry.group) ?? []), entry]);
    }
  }
  INDEXES.set(entries, index);
  return index;
}

/** The one entry a registry lists at this namespace, kind and name. */
export function entryFor(
  entries: readonly Entry[],
  group: string | undefined,
  kind: ArtifactKind,
  name: string,
): Entry | undefined {
  return indexOf(entries).byIdentity.get(identity({ group, kind, name }));
}

/** Every entry named `name`, in catalog order. */
export function entriesNamed(entries: readonly Entry[], name: string): readonly Entry[] {
  return indexOf(entries).byName.get(name) ?? [];
}

/** Every entry inside the namespace or plugin `group`, in catalog order. */
export function entriesIn(entries: readonly Entry[], group: string): readonly Entry[] {
  return indexOf(entries).byGroup.get(group) ?? [];
}
