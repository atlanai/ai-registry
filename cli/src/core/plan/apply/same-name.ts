import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { frontmatterRecord } from "#core/frontmatter.ts";
import type { ActionOf, Linked } from "./run.ts";

// Folders a target that walks its skills tree skips: tool state, caches and dependencies.
const SKIPPED = new Set(["node_modules", "venv", "site-packages", "__pycache__"]);
const DEPTH = 4;

/**
 * Leaves out a new placement beside a skill of its name, which the target would then load neither
 * of. One the lock already records keeps updating, since leaving it would orphan the link.
 */
export async function nameTaken(action: ActionOf<"link">): Promise<Linked | undefined> {
  if (action.nested !== true || action.recorded !== undefined) return undefined;
  const blocker = await sameNameBelow(action.to);
  if (blocker === undefined) return undefined;
  const at = relative(dirname(action.to), blocker);
  const reason = `a skill of the same name is at ${at}, and the target would load neither`;
  return { kept: { name: action.name, path: action.to, reason }, blocker };
}

/**
 * Another skill named like the one bound for `to`, anywhere below `to`'s folder. A skill's name is
 * its front matter's `name`, else its folder's.
 */
function sameNameBelow(to: string): Promise<string | undefined> {
  return search(dirname(to), basename(to), to, DEPTH);
}

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
