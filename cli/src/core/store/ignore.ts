import { dirname, join } from "node:path";
import { writeAtomic } from "#core/fs/atomic.ts";
import { exists } from "#core/fs/tree.ts";
import type { Roots } from "./paths.ts";

/** `.registry/` is committed, so machine-local files are named here, not in the project's own. */
const CONTENTS = [
  "# Files of yours that were in an install's way, moved aside.",
  "backups/",
  "# Uncomment to stop committing installed copies; `aireg install` restores them.",
  "# artifacts/",
  "",
].join("\n");

/** Create-only: once it exists, the project decides what it shares. */
export async function ensureScopeIgnore(roots: Pick<Roots, "scope" | "artifacts">): Promise<void> {
  if (roots.scope === "user") return;
  const path = join(dirname(roots.artifacts), ".gitignore");
  if (await exists(path)) return;
  await writeAtomic(path, CONTENTS);
}
