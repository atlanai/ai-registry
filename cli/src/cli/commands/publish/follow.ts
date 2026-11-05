import { resolve } from "node:path";
import { credentialsForManifest } from "#accounts/credentials.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { digest } from "#core/fs/digest.ts";
import { writeLock } from "#core/lock.ts";
import { pinOf } from "#core/manifest/match.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { Planned } from "#engine/publish/target.ts";
import { type Loaded, withScope } from "#engine/scope/load.ts";
import { applyLocal } from "#engine/sync/local.ts";
import { closeScan, scan } from "#engine/sync/scan.ts";
import { moved, pinnedNote, unservedNote } from "#engine/sync/served.ts";

/**
 * An installed copy that was published holds exactly what landed, so its row is
 * restated from the source. A pinned row is left, or the pin would undo the edit.
 */
export async function follow(
  context: CommandContext,
  loaded: Loaded,
  common: CommonOptions,
  sent: readonly Planned[],
) {
  const rows = new Map<string, string>();
  for (const item of sent) {
    const row = item.work.row;
    const entry = row === undefined ? undefined : loaded.lock.artifacts[row];
    if (row === undefined || entry === undefined) continue;
    const pinned = pinOf(loaded.manifest, entry);
    if (pinned === undefined) rows.set(row, item.version);
    else context.printer.hint(pinnedNote(row, pinned, item.version));
  }
  if (rows.size === 0) return;
  await withScope(loaded.roots, async (fresh) => {
    const found = await scan(fresh, common, {
      credentials: await credentialsForManifest(fresh.manifest.registries, context.cwd),
    });
    try {
      const served = new Set(
        [...rows]
          .filter(([row, version]) => moved(found, fresh.lock.artifacts[row], version))
          .map(([row]) => row),
      );
      for (const [row, version] of rows) {
        const entry = fresh.lock.artifacts[row];
        if (served.has(row) || entry === undefined) continue;
        // What was sent is what is on disk, so the copy stops reading as an edit.
        entry.digest = await digest(resolve(fresh.roots.base, entry.path));
        const note = unservedNote(found, entry, row, version);
        if (note.warning) context.printer.warning(note.message);
        else context.printer.hint(note.message);
      }
      if (served.size > 0) {
        const sentAs = new Map([...served].map((row) => [row, rows.get(row)]));
        await applyLocal(fresh, common, found, served, sentAs, true, () => {});
      } else await writeLock(fresh.roots, fresh.lock);
    } finally {
      await closeScan(found);
    }
  });
}
