import { writeFile } from "node:fs/promises";
import { redirection } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

/** A folder can ship its own links: one anywhere from `root` down to `path` would move the write. */
export function refuseRedirect(
  root: string,
  path: string,
  hint = "Replace it with a real folder, then run it again.",
): void {
  const found = redirection(root, path);
  if (found === undefined) return;
  const what = found.problem === "symlink" ? "a symlink" : "not a folder";
  throw new AiregError(`${found.at} is ${what}, so nothing was written through it.`, {
    code: ErrorCode.Invalid,
    hint,
  });
}

/** Exclusive create: a file that appeared after the checks is reported, never replaced. */
export async function writeFresh(
  path: string,
  content: string,
  conflict: { shown: string; hint: string },
): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new AiregError(`${conflict.shown} already exists.`, {
      code: ErrorCode.Conflict,
      hint: conflict.hint,
    });
  }
}
