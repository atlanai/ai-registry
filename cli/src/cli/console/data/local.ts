import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRow } from "#core/console/model.ts";
import { LOCAL_SOURCE } from "#core/console/model.ts";
import type { Carrier } from "#core/console/runs.ts";
import { canonical } from "#core/fs/realpath.ts";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { candidates } from "#core/sync/adopt.ts";
import type { Targets } from "#core/target/contract.ts";

/** Folders an adapter job already carries, by path, from its newest finished run. */
export type Carried = ReadonlyMap<string, Carrier>;

/**
 * Work in no lock and no registry, found the way `aireg status` finds it. A name a
 * registry already publishes cannot be offered as new work, but is still shown.
 */
export async function localWork(
  roots: Roots,
  targetTable: Targets,
  lock: Lock,
  manifestNames: ReadonlySet<string> = new Set(),
  carried: Carried = new Map(),
): Promise<ArtifactRow[]> {
  const carriers = new Map<string, Carrier>();
  for (const [path, carrier] of carried) carriers.set(canonical(path), carrier);
  const tracked = new Map<string, Tracked>();
  for (const entry of Object.values(lock.artifacts)) {
    tracked.set(entry.name, { from: addressOf(entry) });
  }
  const found = await candidates(roots, targetTable, Object.keys(targetTable), lock);
  const rows: ArtifactRow[] = [];
  for (const item of [...found.local, ...found.undeclared]) {
    const carrier = carriers.get(canonical(item.from));
    const { changedAtMs, edited } = await editsOf(carrier, item.from);
    const { state, detail } = classify(
      tracked.get(item.name),
      manifestNames.has(item.name),
      carrier,
      edited,
    );
    rows.push({
      key: item.name,
      name: item.name,
      kind: item.kind,
      registry: LOCAL_SOURCE,
      namespace: undefined,
      id: "",
      version: undefined,
      lockDigest: "",
      diskDigest: undefined,
      state,
      detail,
      targets: [...new Set([item.target, ...item.elsewhere.map((other) => other.target)])].sort(),
      copy: item.from,
      changedAtMs,
      links: [],
      carriedBy: carrier?.jobId,
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function addressOf(entry: Lock["artifacts"][string]): string {
  const within = entry.namespace === undefined ? "" : `${entry.namespace}/`;
  return `${entry.registry}/${within}${entry.kind}/${entry.name}`;
}

/** An installed artifact a local folder shares its name with, as a person would address it. */
interface Tracked {
  from: string;
}

/** When a carried folder last changed, and whether that was after its job last ran. */
async function editsOf(
  carrier: Carrier | undefined,
  path: string,
): Promise<{ changedAtMs: number | undefined; edited: boolean }> {
  if (carrier === undefined) {
    return { changedAtMs: (await stat(path).catch(() => undefined))?.mtimeMs, edited: false };
  }
  const changedAtMs = await newestChange(path);
  return {
    changedAtMs,
    edited: carrier.settledAtMs !== undefined && changedAtMs > carrier.settledAtMs,
  };
}

/** The newest mtime under a skill folder, bounded: an edit to any file counts. */
async function newestChange(dir: string, depth = 4): Promise<number> {
  let newest = (await stat(dir).catch(() => undefined))?.mtimeMs ?? 0;
  if (depth === 0) return newest;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.slice(0, 500)) {
    const path = join(dir, name);
    const entry = await lstat(path).catch(() => undefined);
    if (entry === undefined || entry.isSymbolicLink()) continue;
    newest = Math.max(
      newest,
      entry.isDirectory() ? await newestChange(path, depth - 1) : entry.mtimeMs,
    );
  }
  return newest;
}

function classify(
  tracked: Tracked | undefined,
  declared: boolean,
  carrier: Carrier | undefined,
  edited: boolean,
): { state: ArtifactRow["state"]; detail: string } {
  // The lock wins: this directory is a second copy of something installed, not
  // work of its own, and publishing it would collide with that name.
  if (tracked !== undefined) {
    return {
      state: "duplicate",
      detail: `same name as ${tracked.from}, installed here; rename this folder to publish it, or remove it to use the installed one`,
    };
  }
  // A job owns this folder's way into the account, so an edit waits for that job.
  if (carrier !== undefined) {
    if (edited) {
      return {
        state: "edited",
        detail: `edited since job ${carrier.job} last ran; [p] runs it now`,
      };
    }
    const held = carrier.outcome === "attention";
    return {
      state: "imported",
      detail: `carried by job ${carrier.job}${held ? `; needs attention: ${carrier.detail ?? "see the run"}` : ""}`,
    };
  }
  // What a push leaves behind: the registry has it, nothing has resolved
  // its id back yet.
  if (declared) {
    return { state: "pending", detail: "published; run `aireg install` to track it" };
  }
  return { state: "unpublished", detail: "written here, offered to no registry" };
}
