import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, relative, resolve, sep } from "node:path";
import { expandHome, isWithin } from "#adapter/paths.ts";
import { canonical } from "./realpath.ts";

/** `HOME`, then `USERPROFILE`, then what the OS reports, so a test or a moved home is honored. */
export function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** `to` from `from` as a person types a relative folder: `.`, `../x` or `./x`. */
export function dotRelative(from: string, to: string): string {
  const path = posixRelative(from, to);
  if (path === "") return ".";
  return path === ".." || path.startsWith("../") ? path : `./${path}`;
}

/** `to` from `from` with `/` on every platform, as a lock or a manifest records it. */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join(posix.sep);
}

/** `path` is inside `dir` and is not `dir` itself. */
export function isStrictlyWithin(dir: string, path: string): boolean {
  return isWithin(dir, path) && relative(resolve(dir), resolve(path)) !== "";
}

/** Nothing is at the path, or an ancestor of it is a file, so nothing can be. */
export function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Nothing is at the path a filesystem call was given. */
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Your home folder as `env` names it, canonical: the user scope's base and every
 * target root under it then compare alike, even with the home behind a symlink.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(userHome(env));
}

/** `~` and `~/…` against `homeDir(env)`; anything else as written. */
export function expandUserPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(path, homeDir(env));
}

/** A file's text, or undefined when nothing is there; any other failure is thrown. */
export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
