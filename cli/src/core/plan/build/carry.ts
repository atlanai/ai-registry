import { resolve } from "node:path";
import { withheldAt } from "#core/catalog/withheld.ts";
import type { LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import type { Closure } from "#core/plan/depends.ts";
import type { Acquired, Kept, Selected } from "#core/plan/model.ts";
import { type NamespaceWant, namespaceOf, pluginLinkAt } from "#core/plan/projection.ts";
import { addressOf } from "#core/plan/select.ts";
import type { BuildState } from "./state.ts";

/** Carries a row the plan does not reclaim, so no row that goes takes its links with it. */
export function keep(build: BuildState, name: string, entry: LockArtifact): void {
  build.next.artifacts[name] = entry;
  for (const link of entry.links) {
    build.claimed.set(resolve(build.options.roots.base, link.path), name);
  }
}

/** Carries what the lock holds from registries this run did not open, claiming their links. */
export function carryUnopened(build: BuildState): Map<string, string> {
  const carried = new Map<string, string>();
  const { opened } = build.options;
  if (opened === undefined) return carried;
  const open = new Set(opened);
  for (const [alias, source] of Object.entries(build.lock.registries)) {
    if (!open.has(alias)) build.next.registries[alias] = source;
  }
  for (const [name, entry] of Object.entries(build.lock.artifacts)) {
    if (open.has(entry.registry)) continue;
    keep(build, name, entry);
    carried.set(name, entry.registry);
    build.addresses.set(
      name,
      addressOf({ group: entry.namespace, kind: entry.kind, name: entry.name }, entry.registry),
    );
  }
  return carried;
}

/**
 * Rows another run owns: a run that names what it opens owns those registries' rows, else what it
 * read. An undeclared, unasked registry is going, so only your own rows it carries still hold.
 */
export function heldElsewhere(
  build: BuildState,
  manifest: Manifest,
  acquired: readonly Acquired[],
  carried: ReadonlyMap<string, string>,
): [string, LockArtifact][] {
  if (build.options.opened !== undefined) {
    return Object.entries(build.lock.artifacts).filter(([name]) => carried.has(name));
  }
  const read = new Set(acquired.map((source) => source.alias));
  const asked = new Set(manifest.artifacts.map((ref) => ref.registry));
  return Object.entries(build.lock.artifacts).filter(
    ([, entry]) =>
      !read.has(entry.registry) &&
      manifest.registries[entry.registry] !== undefined &&
      (asked.has(entry.registry) || entry.origin !== undefined),
  );
}

/** Every namespace this plan holds, per harness: what it installs and what others hold. */
export function namespaceWants(
  selected: readonly Selected[],
  carried: ReadonlyMap<string, string>,
  held: readonly [string, LockArtifact][],
  build: BuildState,
): NamespaceWant[] {
  const wants: NamespaceWant[] = [];
  for (const item of selected) {
    if (carried.has(item.name)) continue;
    if (item.kind !== "plugin" && !build.wrapping.has(item.source)) continue;
    const namespace = namespaceOf(item);
    for (const harness of item.targets ?? build.options.targets) {
      wants.push({ harness, namespace, source: item.source });
    }
  }
  for (const [name, entry] of held) {
    const namespace = namespaceOf({
      kind: entry.kind,
      name,
      group: entry.namespace,
      source: entry.registry,
    });
    // An unread registry's adapter is not loaded: where its rows' links sit says whether it wraps.
    const holding = entry.links.filter(
      (link) =>
        entry.kind === "plugin" ||
        pluginLinkAt(link, namespace, entry.registry, build.options) !== undefined,
    );
    for (const harness of new Set(holding.map((link) => link.harness))) {
      wants.push({ harness, namespace, source: entry.registry });
    }
  }
  return wants;
}

/**
 * A row whose registry withholds the version it reached, as when it is blocked, stays as the lock
 * has it: unpublished is taken for gone, withheld is not.
 */
export function carryWithheld(build: BuildState, acquired: readonly Acquired[]): Kept[] {
  const kept: Kept[] = [];
  for (const source of acquired) {
    for (const [name, row] of Object.entries(build.lock.artifacts)) {
      if (row.registry !== source.alias || build.next.artifacts[name] !== undefined) continue;
      const at = { name: row.name, group: row.namespace, kind: row.kind };
      const withheld = withheldAt(source.catalog.withheld, at);
      if (withheld === undefined) continue;
      keep(build, name, row);
      kept.push({ name, installed: row.version, withheld });
    }
  }
  return kept;
}

/**
 * A dependency the sources did not list, which the lock holds at the version
 * needed, stays as the lock has it rather than being taken for stale.
 */
export function carryUnresolved(build: BuildState, needs: Closure): void {
  for (const { alias, need } of needs.unresolved) {
    const found = Object.entries(build.lock.artifacts).find(
      ([, row]) =>
        row.registry === alias &&
        row.namespace === need.namespace &&
        row.kind === need.kind &&
        row.name === need.name &&
        row.version === need.version,
    );
    if (found === undefined || build.next.artifacts[found[0]] !== undefined) continue;
    const [name, row] = found;
    keep(build, name, { ...row, neededBy: build.neededBy.get(name) });
    const source = build.lock.registries[alias];
    if (source !== undefined) build.next.registries[alias] ??= source;
  }
}
