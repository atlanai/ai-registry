import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { canonical } from "#core/fs/canonical.ts";
import { inspect } from "#core/fs/link.ts";
import type { LinkMode } from "#core/lock.ts";
import { moveToBackup } from "#core/store/backups.ts";
import { assertRemovable, type RemovableRoots, removal } from "./removable.ts";

/**
 * What may happen to whatever sits where a link is about to go. Only what aireg
 * made is replaced; nothing a person put there is ever deleted.
 */
export type LinkGuard =
  /** Nothing there, or aireg's own link or copy. */
  | "replace"
  /** A person swapped a link the lockfile recorded for their own: moved aside first. */
  | "backup"
  /** Never linked here by aireg, or reached through a link: left alone. */
  | "keep";

export async function guardLink(
  to: string,
  recorded: LinkMode | undefined,
  roots: RemovableRoots,
  /** What a written placement would hold, and the file it would hold it in. */
  rendered?: { file: string; text: string },
): Promise<LinkGuard> {
  const state = await inspect(to);
  if (!state.exists) return "replace";
  if (removal(to, roots).how === "refuse") return "keep";
  const ours =
    state.isLink && state.target !== undefined
      ? isWithin(canonical(dirname(roots.artifacts)), canonical(state.target))
      : recorded === "copy";
  if (ours) return "replace";
  // A file already holding what would be written is ours to take on.
  if (rendered !== undefined && !state.isLink && (await holdsOnly(to, rendered))) return "replace";
  return recorded === undefined ? "keep" : "backup";
}

/** The written file and, for a folder, nothing else beside it. */
async function holdsOnly(to: string, rendered: { file: string; text: string }): Promise<boolean> {
  if (rendered.file !== to) {
    const inside = await readdir(to).catch(() => []);
    if (inside.length !== 1 || inside[0] !== basename(rendered.file)) return false;
  }
  return (await readFile(rendered.file, "utf8").catch(() => undefined)) === rendered.text;
}

/** Filed by target and the directory it sat in, the layout a claimed folder uses too. */
export async function backUp(
  to: string,
  target: string,
  roots: RemovableRoots,
  stamp: string,
): Promise<string> {
  await assertRemovable(to, roots);
  return moveToBackup(to, roots, stamp, join(target, basename(dirname(to)), basename(to)));
}
