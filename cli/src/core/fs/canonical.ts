import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

/**
 * Where a path actually resolves, so a link recorded under it compares equal to
 * one read back later. A path that does not exist yet is left as written. Native, as
 * `realpath` from fs/promises is, so a Windows short name such as `RUNNER~1` expands.
 */
export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** `canonical`, off the event loop, for a caller resolving many paths at once. */
export async function canonicalAsync(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
