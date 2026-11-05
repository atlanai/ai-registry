import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import type { Roots } from "./paths.ts";

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

/** Beside the scope's content tree, so a person finds what was moved where the registry lives. */
function backupsDir(roots: Pick<Roots, "artifacts">): string {
  return join(dirname(roots.artifacts), "backups");
}

async function isTaken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
