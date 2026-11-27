import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import { entries, subdirectories } from "#core/fs/tree.ts";
import type { Roots } from "./paths.ts";

/** One thing a run moved aside, filed as `<stamp>/<target>/<dir>/<name>`. */
export interface BackupItem {
  /** The target folder it sat in, as the run filed it, such as `claude-code`. */
  target: string;
  /** The folder within the target, such as `skills`. */
  dir: string;
  name: string;
  /** Where it is now. */
  path: string;
}

export interface BackupRun {
  stamp: string;
  /** Undefined for a folder whose name is not a stamp. */
  atMs: number | undefined;
  items: BackupItem[];
}

/** Sortable and free of characters a filesystem refuses. */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]|\.\d+/g, "");
}

/**
 * Renamed, never copied or deleted, so a link moves as the link.
 * A place already taken by a run in the same second gets `<stamp>-2` and on.
 */
export async function moveToBackup(
  from: string,
  roots: Pick<Roots, "artifacts">,
  stamp: string,
  /** Such as `claude/skills/lint`. */
  within: string,
): Promise<string> {
  const base = backupsDir(roots);
  // A profile's target id, such as `tool:work`, holds a colon Windows paths refuse.
  const at = within.replaceAll(":", "-");
  let to = join(base, stamp, at);
  for (let next = 2; await isTaken(to); next += 1) to = join(base, `${stamp}-${next}`, at);
  await assertUnredirected(dirname(roots.artifacts), to);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return to;
}

/** Newest first, leaving out a run with nothing left in it. Never reads through a link. */
export async function listBackups(roots: Pick<Roots, "artifacts">): Promise<BackupRun[]> {
  const base = backupsDir(roots);
  await assertUnredirected(dirname(roots.artifacts), base);
  const runs: BackupRun[] = [];
  for (const stamp of await subdirectories(base)) {
    const items: BackupItem[] = [];
    for (const target of await subdirectories(join(base, stamp))) {
      for (const dir of await subdirectories(join(base, stamp, target))) {
        const at = join(base, stamp, target, dir);
        for (const entry of await entries(at)) {
          if (entry.name.startsWith(".")) continue;
          items.push({ target, dir, name: entry.name, path: join(at, entry.name) });
        }
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target));
    if (items.length > 0) runs.push({ stamp, atMs: stampTime(stamp), items });
  }
  return runs.sort((a, b) => compareStamps(b.stamp, a.stamp));
}

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?$/;

/** The time `backupStamp` wrote, in milliseconds since 1970. */
export function stampTime(stamp: string): number | undefined {
  const parts = STAMP.exec(stamp)?.slice(1, 7).map(Number);
  if (parts === undefined) return undefined;
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** A `-<n>` run came later in the same second, and `-10` after `-9`. */
function compareStamps(a: string, b: string): number {
  const suffix = (stamp: string) => Number(STAMP.exec(stamp)?.[7] ?? 1);
  const base = (stamp: string) => stamp.replace(/-\d+$/, "");
  return base(a).localeCompare(base(b)) || suffix(a) - suffix(b) || a.localeCompare(b);
}

/** Beside the scope's content tree, so a person finds what was moved where the registry lives. */
export function backupsDir(roots: Pick<Roots, "artifacts">): string {
  return join(dirname(roots.artifacts), "backups");
}

async function isTaken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
