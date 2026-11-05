import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

/**
 * So a link recorded under a path compares equal later; a missing path stays as written.
 * Native, so a Windows short name like `RUNNER~1` expands.
 */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Any path that will not resolve, a link loop as much as a missing one, compares as written.
    return path;
  }
}

/** Off the event loop, for a caller resolving many paths at once. */
export async function canonicalAsync(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
