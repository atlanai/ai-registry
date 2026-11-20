import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { frontmatterRecord } from "#core/frontmatter.ts";
import type { ActionOf, Linked } from "./run.ts";

// Folders a target that walks its skills tree skips: tool state, caches and dependencies.
const SKIPPED = new Set(["node_modules", "venv", "site-packages", "__pycache__"]);

/**
 * Leaves out a new placement beside a skill of its name within the depth the target finds skills
 * at. One the lock already records keeps updating, since leaving it would orphan the link.
 */
export async function nameTaken(action: ActionOf<"link">): Promise<Linked | undefined> {
  const depth = action.depth ?? 1;
  if (depth < 2 || action.recorded !== undefined) return undefined;
  const blocker = await search(dirname(action.to), basename(action.to), action.to, depth);
  if (blocker === undefined) return undefined;
  const at = relative(dirname(action.to), blocker);
  const reason = `a skill of the same name is at ${at}, which the target finds too`;
  return { kept: { name: action.name, path: action.to, reason }, blocker };
}

/** A skill called `name`, by front matter else folder, up to `depth` folders below `dir`. */
async function search(
  dir: string,
  name: string,
  skip: string,
  depth: number,
): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (path === skip || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const own = await skillName(path);
    if (own === name) return path;
    // A skill's own folders are its files; a linked folder is not walked, so no loop is followed.
    if (own === undefined && entry.isDirectory() && depth > 1) {
      const deeper = await search(path, name, skip, depth - 1);
      if (deeper !== undefined) return deeper;
    }
  }
  return undefined;
}

async function skillName(folder: string): Promise<string | undefined> {
  const text = await readFile(join(folder, SKILL_ENTRY), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const declared = frontmatterRecord(text)?.name;
  return typeof declared === "string" && declared.trim() !== ""
    ? declared.trim()
    : basename(folder);
}
