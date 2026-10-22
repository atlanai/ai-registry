import type { Artifact, Credential, Want } from "#adapter/index.ts";
import { readTargets } from "#core/harness/index.ts";
import { cloneLock, type Lock } from "#core/lock.ts";
import { acquire } from "#core/plan/acquire.ts";
import type { Roots } from "#core/store/paths.ts";
import { type Candidate, candidates } from "#core/sync/adopt.ts";
import { reconcile } from "#core/sync/index.ts";
import type { SyncItem } from "#core/sync/model.ts";
import type { CommonOptions } from "./options.ts";
import { type Loaded, resolveTargets } from "./pipeline.ts";

export interface Scan {
  items: SyncItem[];
  /** Where this scope's own copies live, which is what a publish sends. */
  roots: Roots;
  local: Candidate[];
  undeclared: Candidate[];
  publisher: Map<string, string>;
  pinned: Lock;
  acquired: Awaited<ReturnType<typeof acquire>>;
}

export interface ScanOptions {
  /** Registries to open; absent means every one the manifest asks for. */
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

  const targets = resolveTargets(loaded.manifest, loaded.harnesses, common);
  const discovered = await candidates(
    loaded.roots,
    loaded.harnesses,
    readTargets(targets, loaded.harnesses),
    pinned,
    new Set(publisher.keys()),
  );
  const unique = (items: Candidate[]) => [
    ...new Map(items.map((item) => [`${item.kind}:${item.name}`, item])).values(),
  ];
  const local = unique([...discovered.local]);
  const undeclared = unique([...discovered.undeclared]);
  return { items, roots: loaded.roots, local, undeclared, publisher, pinned, acquired };
}

/**
 * Closes the sources a scan opened. The daemon scans again and again, so a
 * source holding a connection or a timer would otherwise keep it for good.
 */
export async function closeScan(found: Pick<Scan, "acquired">): Promise<void> {
  await Promise.allSettled(found.acquired.map((source) => source.close()));
}
