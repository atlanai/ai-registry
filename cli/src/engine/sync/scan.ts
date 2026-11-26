import type { Artifact, Credential, Want } from "#adapter/index.ts";
import { normalizedDigest } from "#core/fs/digest.ts";
import { cloneLock, type Lock } from "#core/lock.ts";
import { acquire } from "#core/plan/acquire/acquire.ts";
import type { Roots } from "#core/store/paths.ts";
import { type Candidate, candidates } from "#core/sync/adopt.ts";
import type { SyncItem } from "#core/sync/model.ts";
import { reconcile } from "#core/sync/reconcile.ts";
import { readTargets } from "#core/target/placement.ts";
import { selectTargets } from "#engine/install/targets.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Loaded } from "#engine/scope/load.ts";

export interface Scan {
  items: SyncItem[];
  roots: Roots;
  local: Candidate[];
  /** Unmanaged skills of one name with different files in different target folders. */
  differing: Candidate[];
  undeclared: Candidate[];
  publisher: Map<string, string>;
  pinned: Lock;
  acquired: Awaited<ReturnType<typeof acquire>>;
}

export interface ScanOptions {
  /** Absent means every one the manifest asks for. */
  aliases?: readonly string[];
  credentials?: Readonly<Record<string, Credential>>;
  signal?: AbortSignal;
  onStep?(message: string): void;
  onDownload?(artifact: Artifact, bytes: number): void;
}

export async function scan(
  loaded: Loaded,
  common: CommonOptions,
  options: ScanOptions = {},
): Promise<Scan> {
  const pinned = cloneLock(loaded.lock);
  const also = new Map<string, string[]>();
  // A dependency is compared at the version what needs it was installed with.
  const needs = new Map<string, Want[]>();
  for (const row of Object.values(loaded.lock.artifacts)) {
    if (loaded.manifest.registries[row.registry] === undefined) continue;
    if (row.origin !== undefined)
      also.set(row.registry, [...(also.get(row.registry) ?? []), row.name]);
    if (row.neededBy === undefined || row.namespace === undefined || row.version === undefined)
      continue;
    const need = { name: row.name, namespace: row.namespace, kind: row.kind, version: row.version };
    needs.set(row.registry, [...(needs.get(row.registry) ?? []), need]);
  }
  const acquired = await acquire(loaded.manifest, {
    base: loaded.roots.base,
    also,
    needs,
    recorded: loaded.lock,
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onDownload === undefined ? {} : { onDownload: options.onDownload }),
  });
  const items = await reconcile(loaded.manifest, pinned, acquired, loaded.roots);

  const publisher = new Map<string, string>();
  for (const source of acquired) {
    for (const entry of source.catalog.entries) {
      const key = `${entry.kind}:${entry.name}`;
      if (!publisher.has(key)) publisher.set(key, source.alias);
    }
  }

  const targets = selectTargets(loaded.manifest, loaded.targetTable, common);
  const discovered = await candidates(
    loaded.roots,
    loaded.targetTable,
    readTargets(targets, loaded.targetTable),
    pinned,
    new Set(publisher.keys()),
  );
  const unique = (items: Candidate[]) => [
    ...new Map(items.map((item) => [`${item.kind}:${item.name}`, item])).values(),
  ];
  const { kept, differing } = await withoutDiffering(discovered.local);
  const local = unique(kept);
  const undeclared = unique([...discovered.undeclared]);
  return { items, roots: loaded.roots, local, differing, undeclared, publisher, pinned, acquired };
}

/** One line per name, as `status` words its duplicates, with each copy's path. */
export function differingNote(item: Candidate, shown: (path: string) => string): string {
  const paths = [item.from, ...item.elsewhere.map((copy) => copy.from)].map(shown).sort();
  return `${paths.length} different ${item.name} ${item.kind}s, so none was taken: ${paths.join(", ")}.`;
}

/**
 * Unmanaged skills of one name whose files differ are different skills, and each target
 * may load its own, so nothing here may pick one: `publish <path>` names the one meant.
 */
export async function withoutDiffering(
  found: readonly Candidate[],
): Promise<{ kept: Candidate[]; differing: Candidate[] }> {
  const kept: Candidate[] = [];
  const differing: Candidate[] = [];
  for (const item of found) {
    if (item.kind !== "skill" || item.elsewhere.length === 0) {
      kept.push(item);
      continue;
    }
    const paths = [item.from, ...item.elsewhere.map((copy) => copy.from)];
    const digests = new Set(await Promise.all(paths.map((path) => normalizedDigest(path))));
    (digests.size > 1 ? differing : kept).push(item);
  }
  return { kept, differing };
}

/** The daemon scans repeatedly, so an open connection or timer would otherwise leak. */
export async function closeScan(found: Pick<Scan, "acquired">): Promise<void> {
  await Promise.allSettled(found.acquired.map((source) => source.close()));
}
