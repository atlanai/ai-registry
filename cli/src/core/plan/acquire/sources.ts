import { quoted } from "#adapter/text.ts";
import { type Entry, entryFor } from "#core/catalog/catalog.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Lock, LockArtifact, LockRegistry } from "#core/lock.ts";
import type { Acquired, Fetch, Origin } from "#core/plan/model.ts";

export function fetchFrom(acquired: readonly Acquired[]): Fetch {
  const byAlias = new Map(acquired.map((entry) => [entry.alias, entry]));
  return (source, path) => {
    const found = byAlias.get(source);
    return found === undefined
      ? Promise.reject(
          new AiregError(`Registry ${quoted(source)} is no longer available.`, {
            code: ErrorCode.NotFound,
          }),
        )
      : found.content(path);
  };
}

/** Where a registry lists a lock row; one of yours has no address until a publish of it is recorded. */
export function listedAt(row: LockArtifact, entries: readonly Entry[]): string | undefined {
  if (row.address !== undefined || row.origin === undefined) return row.address;
  return entryFor(entries, row.namespace, row.kind, row.name)?.path;
}

export function lockSourceOf(origin: Origin): LockRegistry {
  return {
    location: origin.declared,
    adapter: origin.adapter,
    key: origin.key,
    config: origin.config,
    revision: origin.revision,
  };
}

export function dropUnusedSources(lock: Lock): void {
  for (const alias of Object.keys(lock.registries)) {
    const used = Object.values(lock.artifacts).some((entry) => entry.registry === alias);
    if (!used) delete lock.registries[alias];
  }
}
