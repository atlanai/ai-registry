import { quoted } from "#adapter/text.ts";
import { entryFor } from "#core/catalog/catalog.ts";
import { withheldAt } from "#core/catalog/withheld.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { lockView } from "#core/plan/acquire/lock-view.ts";
import type { Acquired } from "./model.ts";

/** An installed artifact the manifest still asks for, which its registry no longer lists. */
export interface Unlisted {
  /** Its installed name. */
  name: string;
  registry: string;
  /** The registry lists nothing at all, which reads as a broken listing, not one retired artifact. */
  empty: boolean;
}

/**
 * Rows a registry read this run stopped listing, though the manifest still reaches them. A short
 * listing is not a removal; only a complete read of the whole listing drops an unnamed row.
 */
export function unlistedRows(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
): Unlisted[] {
  const view = lockView(lock);
  const reached = new Set(manifest.artifacts.flatMap((ref) => view.reached(ref)));
  const named = new Set(
    manifest.artifacts.filter((ref) => ref.name !== undefined).flatMap((ref) => view.reached(ref)),
  );
  const found: Unlisted[] = [];
  for (const source of acquired) {
    for (const [name, row] of view.rows(source.alias)) {
      // A row of yours is published from your folder, so the registry not listing it is expected.
      if (row.origin !== undefined || !reached.has(name) || listed(row, source)) continue;
      const at = { name: row.name, group: row.namespace, kind: row.kind };
      if (withheldAt(source.catalog.withheld, at) !== undefined) continue;
      if (deletedFrom(source) && !named.has(name)) continue;
      const empty = source.whole === true && source.catalog.entries.length === 0;
      found.push({ name, registry: source.alias, empty });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function listed(row: LockArtifact, source: Acquired): boolean {
  const { entries } = source.catalog;
  if (row.address !== undefined && entries.some((entry) => entry.path === row.address)) return true;
  return entryFor(entries, row.namespace, row.kind, row.name) !== undefined;
}

/** An empty listing is still taken for a broken read, whatever the adapter says of it. */
function deletedFrom(source: Acquired): boolean {
  return (
    source.whole === true && source.catalog.complete === true && source.catalog.entries.length > 0
  );
}

/** Why a row is held, for a sync to show beside its name. */
export function unlistedReason(item: Unlisted): string {
  return item.empty
    ? `${item.registry} lists no artifacts now`
    : `${item.registry} no longer lists it`;
}

/** Why a row was kept, worded to end a sentence. */
export function unlistedMessage(item: Unlisted): string {
  return item.empty
    ? `${item.registry} lists no artifacts now, so ${quoted(item.name)} was kept`
    : `${item.registry} no longer lists ${quoted(item.name)}, so it was kept`;
}
