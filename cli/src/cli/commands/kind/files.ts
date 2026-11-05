import { writeFile } from "node:fs/promises";
import { redirection } from "#adapter/files.ts";
import { isDeviceName } from "#adapter/filespec/names.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

/** `aireg registry validate` refuses this, so the person must fill it in. */
export const PLACEHOLDER = "TODO";

/** Copies that never write over anything, so a file already there is a conflict, not lost. */
export const FRESH = { recursive: true, errorOnExist: true, force: false } as const;

/**
 * Every write here lands under `root`, and a registry ships its own folders: a link
 * anywhere from `root` down to `path` would put the new files somewhere else.
 */
export function refuseRedirect(root: string, path: string): void {
  const found = redirection(root, path);
  if (found === undefined) return;
  const what = found.problem === "symlink" ? "a symlink" : "not a folder";
  throw new AiregError(`${found.at} is ${what}, so nothing was written through it.`, {
    code: ErrorCode.Invalid,
    hint: "Replace it with a real folder, then run it again.",
  });
}

/** Exclusive create: a file that appeared after the checks is reported, never replaced. */
export async function writeFresh(path: string, content: string, shown: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new AiregError(`${shown} already exists.`, {
      code: ErrorCode.Conflict,
      hint: "Move it aside, or name a new artifact.",
    });
  }
}

/** Accepted by the grammar, but no Windows checkout could hold it. */
export function refuseDevice(name: string): void {
  if (!isDeviceName(name)) return;
  throw new AiregError(`${quoted(name)} is a device name on Windows.`, {
    code: ErrorCode.Usage,
    hint: "Choose another name; con, prn, aux, nul, com1 to com9 and lpt1 to lpt9 cannot be folder names on Windows.",
  });
}
