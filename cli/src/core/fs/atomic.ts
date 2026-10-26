import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAtomic as write } from "#adapter/files.ts";
import { assertLeasesHeld } from "#core/lease.ts";
import { PRIVATE_FILE, PUBLIC_FILE } from "./mode.ts";
import { isMissing } from "./path.ts";

/**
 * A killed process leaves the old file or the new one, never half of either, and
 * a process that lost its scope's lease never lands one.
 */
export function writeAtomic(
  target: string,
  contents: string | Uint8Array,
  mode = PUBLIC_FILE,
  /** False skips the syncs, for files a caller can simply write again after a crash. */
  durable = true,
): Promise<void> {
  return write(target, contents, { mode, durable, beforeRename: assertLeasesHeld });
}

/** The file a write to `path` should land in: what a link names, even one whose file is not there yet. */
async function landing(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const info = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  return info?.isSymbolicLink() === true ? resolve(dirname(path), await readlink(path)) : path;
}

/**
 * For a person's own file, such as a target config: written through a link, so one a
 * dotfiles manager placed stays linked, and with the mode it has. A new one is owner-only.
 */
export async function rewriteAtomic(path: string, contents: string): Promise<void> {
  const target = await landing(path);
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    (error: unknown) => {
      if (isMissing(error)) return PRIVATE_FILE;
      throw error;
    },
  );
  await writeAtomic(target, contents, mode);
}
