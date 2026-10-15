import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Every path under `root`, links marked, for a failure message to show what is on disk. */
export function tree(root: string): string {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return entry.isSymbolicLink() ? `${path} (link)` : path;
      })
      .sort()
      .join("\n");
  } catch (error) {
    return `${root}: ${(error as Error).message}`;
  }
}
