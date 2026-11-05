import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

/**
 * Where a path resolves, so a link recorded under it compares equal later; a missing path stays as
 * written. Native, as fs/promises `realpath` is, so a Windows short name like `RUNNER~1` expands.
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
