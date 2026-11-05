import { isLayoutId } from "#adapter/layouts/ids.ts";
import { quoted, sanitizeName } from "#adapter/text.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { Need } from "#core/plan/depends.ts";
import type { Acquired, Placement } from "#core/plan/model.ts";
import { candidates } from "#core/plan/select.ts";
import type { Ref } from "#core/ref.ts";

/** A lock as plans read it: rows grouped by registry once, each registry's view built once. */
export interface LockView {
  /** The rows recorded from one registry, by installed name. */
  rows(alias: string): readonly (readonly [string, LockArtifact])[];
  /** The registry as the lock last resolved it, or undefined when the lock has none. */
  source(alias: string): Acquired | undefined;
  /** The locked rows a reference reaches, by installed name. */
  reached(ref: Ref): string[];
}

export function lockView(lock: Lock): LockView {
  const byRegistry = new Map<string, [string, LockArtifact][]>();
  for (const [name, row] of Object.entries(lock.artifacts)) {
    const rows = byRegistry.get(row.registry) ?? [];
    rows.push([name, row]);
    byRegistry.set(row.registry, rows);
  }
  const rows = (alias: string) => byRegistry.get(alias) ?? [];
  const built = new Map<string, { source: Acquired; at: Map<string, string> } | undefined>();
  const registry = (alias: string) => {
    if (!built.has(alias)) {
      const source = fromRows(lock, alias, rows(alias));
      const at = new Map<string, string>();
      for (const [name, row] of rows(alias))
        if (row.address !== undefined) at.set(row.address, name);
      built.set(alias, source === undefined ? undefined : { source, at });
    }
    return built.get(alias);
  };
  return {
    rows,
    source: (alias) => registry(alias)?.source,
    reached(ref) {
      const found = registry(ref.registry);
      if (found === undefined) return [];
      return candidates(ref, found.source).flatMap((entry) => found.at.get(entry.path) ?? []);
    },
  };
}

function fromRows(
  lock: Lock,
  alias: string,
  rows: readonly (readonly [string, LockArtifact])[],
): Acquired | undefined {
  const source = lock.registries[alias];
  if (source === undefined) return undefined;
  const { layout } = source.config;
  const entries: Entry[] = [];
  const placements = new Map<string, Placement>();
  const needs = new Map<string, Need[]>();
  for (const [, row] of rows) {
    if (row.namespace === undefined || row.version === undefined) {
      continue;
    }
    const need = { namespace: row.namespace, kind: row.kind, name: row.name, version: row.version };
    for (const by of row.neededBy ?? []) needs.set(by, [...(needs.get(by) ?? []), need]);
  }
  for (const [name, row] of rows) {
    if (row.id === undefined || row.address === undefined) continue;
    entries.push({
      name: sanitizeName(row.name),
      kind: row.kind,
      path: row.address,
      group: row.namespace,
      description: undefined,
      engine: undefined,
      from: { file: source.adapter, pointer: row.id },
    });
    placements.set(row.address, {
      id: row.id,
      name: row.name,
      contentId: row.content,
      version: row.version,
      needs: needs.get(name),
      ...(row.revision === undefined ? {} : { revision: row.revision }),
    });
  }
  return {
    alias,
    origin: {
      adapter: source.adapter,
      location: source.location,
      declared: source.location,
      key: source.key,
      config: source.config,
      revision: source.revision,
      ...(layout !== undefined && isLayoutId(layout) ? { layout } : {}),
    },
    placements,
    catalog: { root: source.adapter, layouts: [], entries, warnings: [] },
    content: () => Promise.reject(new Error(`Registry ${quoted(alias)} was not opened.`)),
    close: async () => {},
  };
}

/** The locked rows a reference reaches, by installed name. */
export function reached(lock: Lock, ref: Ref): string[] {
  return lockView(lock).reached(ref);
}

/**
 * Whether the lock alone answers every reference the manifest makes to this registry where it
 * still declares it. With `held`, a reference whose every match is excluded asks for nothing.
 */
export function answers(manifest: Manifest, source: Acquired, held = false): boolean {
  const declared = manifest.registries[source.alias];
  if (
    declared === undefined ||
    declared.location !== source.origin.declared ||
    (declared.adapter !== undefined && declared.adapter !== source.origin.adapter) ||
    JSON.stringify(declared.config) !== JSON.stringify(source.origin.config)
  ) {
    return false;
  }
  return manifest.artifacts
    .filter((ref) => ref.registry === source.alias)
    .every((ref) => {
      const found = candidates(ref, source);
      if (found.length === 0) return held && ref.exclude !== undefined;
      return (
        ref.version === undefined ||
        found.every((entry) => source.placements.get(entry.path)?.version === ref.version)
      );
    });
}
