import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { processAlive } from "#core/process.ts";

/** What a copy of aireg.exe runs with to delete aireg's folder once `self uninstall` exits. */
export const REMOVE_AFTER_FLAG = "--internal-remove-after";

/** Retried, as Windows holds a file a moment after the process using it, such as the daemon, exits. */
export function removeTree(dir: string): Promise<boolean> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).then(
    () => true,
    () => false,
  );
}

/** Waits up to a minute for `pid`, then deletes `dir` if it is aireg's. */
export async function removeAfterExit(pid: number, dir: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Only a folder aireg's layout marks as its own, whatever the arguments say.
  if (isAbsolute(dir) && existsSync(join(dir, "cli"))) await removeTree(dir);
}
