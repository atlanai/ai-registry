import { resolve } from "node:path";
import { digest } from "#core/fs/digest.ts";
import { link } from "#core/fs/link.ts";
import { type Lock, writeLock } from "#core/lock.ts";
import { projectionsOf } from "#core/plan/projection.ts";
import { assertRemovable } from "#core/plan/removable.ts";
import { assemblePlugin } from "./link.ts";
import { type ActionOf, linkKey, type Run } from "./run.ts";

export async function record(run: Run, action: ActionOf<"record">): Promise<void> {
  await recopyPlugins(run);
  // Taken first: a row whose restage failed may still have links reading its projection.
  run.projections = projectionsOf(action.lock, run.roots);
  await keepUnstaged(run, action.lock);
  for (const [name, entry] of Object.entries(action.lock.artifacts)) {
    if (!run.unstaged.has(name)) patchRow(run, name, entry);
  }
  await writeLock(run.roots, action.lock);
  run.recorded = action.lock;
}

/** A copied plugin was copied with the members cloned before it; this one holds them all. */
async function recopyPlugins(run: Run): Promise<void> {
  for (const [to, action] of run.copiedPlugins) {
    await assemblePlugin(run, action);
    await assertRemovable(to, run.roots);
    await link(action.from, to, true);
    run.copies.set(to, await digest(to));
  }
}

/** A row that failed to restage keeps what the lock held; one it never held is not recorded. */
async function keepUnstaged(run: Run, lock: Lock): Promise<void> {
  if (run.unstaged.size === 0) return;
  const held = run.before;
  for (const name of run.unstaged.keys()) {
    const previous = held?.artifacts[name];
    if (previous === undefined) {
      delete lock.artifacts[name];
      continue;
    }
    lock.artifacts[name] = previous;
    const source = held?.registries[previous.registry];
    if (source !== undefined) lock.registries[previous.registry] ??= source;
  }
}

function patchRow(run: Run, name: string, entry: Lock["artifacts"][string]): void {
  const { roots } = run;
  const fresh = run.digests.get(name);
  if (fresh !== undefined) entry.digest = fresh;
  // The identity the store keyed it by, which is what `basis` looks up.
  const identity = run.upstream.get(name);
  if (identity !== undefined) entry.content = identity;
  // Prune reads this list, so a link that was never made must not be
  // in it: the member it would have pointed at does not exist.
  const blocked = entry.links.filter((item) =>
    run.kept.some((held) => held.name === name && held.path === resolve(roots.base, item.path)),
  );
  const held = [...(entry.blocked ?? []), ...blocked.map(({ target, path }) => ({ target, path }))];
  entry.blocked = held.length === 0 ? undefined : held;
  entry.links = entry.links.filter(
    (item) => !run.skipped.has(linkKey(name, resolve(roots.base, item.path))),
  );
  for (const item of entry.links) {
    const at = resolve(roots.base, item.path);
    const mode = run.modes.get(linkKey(name, at)) ?? run.pathModes.get(at);
    if (mode !== undefined) item.mode = mode;
    // A plugin folder is linked once, for its first member, and installs every member it serves.
    if (run.pathModes.has(at)) run.installed.add(name);
    const written = run.copies.get(at);
    if (written !== undefined) item.digest = written;
  }
}
