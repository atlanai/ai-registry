import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import type { Roots } from "./paths.ts";

/** Beside the scope's content tree, so a person finds what was moved where the registry lives. */
function backupsDir(roots: Pick<Roots, "artifacts">): string {
  return join(dirname(roots.artifacts), "backups");
}

/** One directory per run, sortable and free of characters a filesystem refuses. */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]|\.\d+/g, "");
}

async function taken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Renamed, never copied or deleted: the path is recoverable as it was, and a link moves
 * as the link. A place already filled, by a run in the same second, takes `<stamp>-2` on.
 */
export async function moveToBackup(
  from: string,
  roots: Pick<Roots, "artifacts">,
  stamp: string,
  /** Where inside the run's folder it goes, such as `claude/skills/lint`. */
  within: string,
): Promise<string> {
  const base = backupsDir(roots);
  // A profile's target id, such as `tool:work`, holds a colon a Windows path cannot.
  const at = within.replaceAll(":", "-");
  let to = join(base, stamp, at);
  for (let next = 2; await taken(to); next += 1) to = join(base, `${stamp}-${next}`, at);
  await assertUnredirected(dirname(roots.artifacts), to);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return to;
}
