import { resolve } from "node:path";
import { digest } from "#core/fs/digest.ts";
import { link } from "#core/fs/link.ts";
import { type Lock, writeLock } from "#core/lock.ts";
import { projectionsOf } from "#core/plan/projection.ts";
import { assertRemovable } from "#core/plan/removable.ts";
import { assemblePlugin } from "./link.ts";
import {
  type ActionOf,
  linkKey,
  type PluginSource,
  type Recorded,
  type Run,
  type RunResults,
} from "./run.ts";

/** Patches the plan's own lock in place, which is the one it writes and returns. */
export async function record(run: Run, action: ActionOf<"record">): Promise<Recorded> {
  const { roots } = run.inputs;
  const { copies, plugins } = await recopyPlugins(run);
  // Taken first: a row whose restage failed may still have links reading its projection.
  const projections = projectionsOf(action.lock, roots);
  keepUnstaged(run, action.lock);
  const seen = { ...run.results, copies: new Map([...run.results.copies, ...copies]) };
  const installed: string[] = [];
  for (const [name, entry] of Object.entries(action.lock.artifacts)) {
    if (run.results.unstaged.has(name)) continue;
    if (patchRow(seen, roots.base, name, entry)) installed.push(name);
  }
  await writeLock(roots, action.lock);
  return { lock: action.lock, projections, installed, copies, plugins };
}

/** A copied plugin was copied with the members cloned before it; this one holds them all. */
async function recopyPlugins(run: Run): Promise<Pick<Recorded, "copies" | "plugins">> {
  const copies = new Map<string, string>();
  const plugins = new Map<string, PluginSource>();
  for (const [to, action] of run.results.copiedPlugins) {
    const found = plugins.get(action.from) ?? run.results.plugins.get(action.from);
    const plugin = await assemblePlugin(run.inputs, action, found);
    if (plugin !== undefined) plugins.set(action.from, plugin);
    await assertRemovable(to, run.inputs.roots, run.inputs.env);
    await link(action.from, to, true);
    copies.set(to, await digest(to));
  }
  return { copies, plugins };
}

/** A row that failed to restage keeps what the lock held; one it never held is not recorded. */
function keepUnstaged(run: Run, lock: Lock): void {
  const held = run.inputs.before;
  for (const name of run.results.unstaged.keys()) {
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

/** Whether a plugin folder this run linked installs the row. */
function patchRow(
  results: Pick<
    RunResults,
    "digests" | "staged" | "kept" | "skipped" | "modes" | "pathModes" | "copies"
  >,
  base: string,
  name: string,
  entry: Lock["artifacts"][string],
): boolean {
  const fresh = results.digests.get(name);
  if (fresh !== undefined) entry.digest = fresh;
  // The identity the store keyed it by, which is what `basis` looks up.
  const identity = results.staged.get(name)?.contentId;
  if (identity !== undefined) entry.content = identity;
  // Prune reads this list, so a link that was never made must not be
  // in it: the member it would have pointed at does not exist.
  const blocked = entry.links.filter((item) =>
    results.kept.some((held) => held.name === name && held.path === resolve(base, item.path)),
  );
  const held = [...(entry.blocked ?? []), ...blocked.map(({ target, path }) => ({ target, path }))];
  entry.blocked = held.length === 0 ? undefined : held;
  entry.links = entry.links.filter(
    (item) => !results.skipped.has(linkKey(name, resolve(base, item.path))),
  );
  let installs = false;
  for (const item of entry.links) {
    const at = resolve(base, item.path);
    const mode = results.modes.get(linkKey(name, at)) ?? results.pathModes.get(at);
    if (mode !== undefined) item.mode = mode;
    // A plugin folder is linked once, for its first member, and installs every member it serves.
    if (results.pathModes.has(at)) installs = true;
    const written = results.copies.get(at);
    if (written !== undefined) item.digest = written;
  }
  return installs;
}
