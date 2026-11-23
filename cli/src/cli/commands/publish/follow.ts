import { resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { digest } from "#core/fs/digest.ts";
import { canonical } from "#core/fs/realpath.ts";
import { writeLock } from "#core/lock.ts";
import { pinOf } from "#core/manifest/match.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Planned } from "#engine/publish/target.ts";
import { type Loaded, withScope } from "#engine/scope/load.ts";
import { applyLocal } from "#engine/sync/local.ts";
import { closeScan, scan } from "#engine/sync/scan.ts";
import { clashNote, moved, pinnedNote, serves, unservedNote } from "#engine/sync/served.ts";

/**
 * A published copy holds exactly what landed, so its row is restated from the source.
 * A pinned row is left alone, or the pin would undo the edit.
 */
export async function follow(
  context: CommandContext,
  loaded: Loaded,
  common: CommonOptions,
  sent: readonly { alias: string; item: Planned }[],
  /** A git checkout sent into, whose new versions reach no one until git pushes them. */
  checkout?: { registry: string; location: string },
): Promise<boolean> {
  const rows = new Map<string, { version: string; unpushed: boolean }>();
  for (const { alias, item } of sent) {
    const row = item.work.row;
    const entry = row === undefined ? undefined : loaded.lock.artifacts[row];
    if (row === undefined || entry === undefined) continue;
    const pinned = pinOf(loaded.manifest, entry);
    const unpushed =
      checkout !== undefined &&
      alias === checkout.registry &&
      !installsFrom(loaded, entry.registry, checkout.location);
    if (pinned === undefined) rows.set(row, { version: item.version, unpushed });
    else context.printer.hint(pinnedNote(row, pinned, item.version));
  }
  if (rows.size === 0) return false;
  let clash = false;
  await withScope(loaded.roots, async (fresh) => {
    const found = await scan(fresh, common, {
      credentials: await credentialsForManifest(fresh.manifest.registries, context.cwd),
    });
    try {
      // Served already while ours waits in the checkout: a teammate pushed it first.
      const clashed = new Map<string, string>();
      for (const [row, sent] of rows) {
        const taken = sent.unpushed
          ? serves(found, fresh.lock.artifacts[row], sent.version)
          : undefined;
        if (taken !== undefined) clashed.set(row, taken);
      }
      clash = clashed.size > 0;
      const served = new Set(
        [...rows]
          .filter(
            ([row, sent]) =>
              !clashed.has(row) && moved(found, fresh.lock.artifacts[row], sent.version),
          )
          .map(([row]) => row),
      );
      for (const [row, { version }] of rows) {
        const entry = fresh.lock.artifacts[row];
        if (served.has(row) || entry === undefined) continue;
        const taken = clashed.get(row);
        if (taken !== undefined) {
          context.printer.warning(clashNote(row, taken));
          continue;
        }
        // What was sent is what is on disk, so the copy stops reading as an edit.
        entry.digest = await digest(resolve(fresh.roots.base, entry.path));
        const note = unservedNote(found, entry, row, version);
        if (note.warning) context.printer.warning(note.message);
        else context.printer.hint(note.message);
      }
      if (served.size > 0) {
        const sentAs = new Map([...served].map((row) => [row, rows.get(row)?.version]));
        await applyLocal({
          loaded: fresh,
          common,
          scan: found,
          names: served,
          published: sentAs,
          force: true,
          onStep: () => {},
        });
      } else await writeLock(fresh.roots, fresh.lock);
    } finally {
      await closeScan(found);
    }
  });
  return clash;
}

/** The project installs this row from the checkout itself, so what was sent is already served. */
function installsFrom(loaded: Loaded, alias: string, location: string): boolean {
  const declared = loaded.manifest.registries[alias];
  return (
    declared !== undefined &&
    canonical(expandLocation(declared.location, loaded.roots.base)) === canonical(location)
  );
}
