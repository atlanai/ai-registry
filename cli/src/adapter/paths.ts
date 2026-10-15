import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { stripTrailing } from "./text.ts";

const UNPRINTABLE = /\p{Cc}/u;
/** Code points HFS+ ignores in a name, so `.g\u200cit` is `.git` there (as git checks). */
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;

/**
 * A segment some filesystem stores as `.git`: any case, HFS+'s ignored code points,
 * the trailing dots and spaces Windows drops, and the 8.3 short name `git~1`.
 */
function isGitDir(segment: string): boolean {
  const folded = stripTrailing(segment.replace(HFS_IGNORED, "").toLowerCase(), ". ");
  return folded === ".git" || folded === "git~1";
}

/**
 * A relative POSIX path every platform writes inside the folder it is joined to:
 * no empty, `.` or `..` segment, no backslash, no `:` (a drive or a Windows stream),
 * no control character and no `.git` segment, which would make the folder a repository.
 * A spelling that would later be refused or rewritten must never reach the content
 * key, or two byte-identical trees hash differently.
 */
export function isSafePath(path: string): boolean {
  if (path === "" || posix.isAbsolute(path) || UNPRINTABLE.test(path)) return false;
  if (path.includes("\\") || path.includes(":")) return false;
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && !isGitDir(segment),
    );
}

/**
 * Two paths of one artifact that a case-insensitive disk stores as one file, or as a
 * file and the folder another sits in: the later one and the one it lands on.
 */
export function collidingPaths(paths: readonly string[]): [string, string] | undefined {
  const fold = (path: string) => path.normalize("NFC").toLowerCase();
  const files = new Map<string, string>();
  for (const path of paths) {
    const earlier = files.get(fold(path));
    if (earlier !== undefined) return [path, earlier];
    files.set(fold(path), path);
  }
  for (const path of paths) {
    const parts = fold(path).split("/");
    for (let end = 1; end < parts.length; end += 1) {
      const file = files.get(parts.slice(0, end).join("/"));
      if (file !== undefined) return [path, file];
    }
  }
  return undefined;
}

/** True when `target` resolves to `base` itself or something underneath it. */
export function isWithin(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") return true;
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** Every path built from remote input passes through here before it is used. */
export function assertWithin(base: string, target: string, what = "path"): void {
  if (!isWithin(base, target)) {
    throw new Error(`Refusing to use ${what} outside ${base}: ${target}`);
  }
}

/** Written the way a person types a folder, rather than a registry name or a URL. */
export function isLocalPath(input: string): boolean {
  return input.startsWith(".") || input.startsWith("~") || isAbsolute(input);
}

/** `~`, `~/…` and on Windows `~\…`, against the person's home; anything else as written. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  const typed = path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"));
  return typed ? join(home, path.slice(2)) : path;
}

/**
 * `env` with PATH reduced to its absolute folders. A spawn resolves an empty or relative entry
 * against the child's working folder, which may be a checkout a registry wrote.
 */
export function withAbsolutePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PATH === undefined) return env;
  const folders = env.PATH.split(delimiter).filter((folder) => isAbsolute(folder));
  return { ...env, PATH: folders.join(delimiter) };
}

/** Cheap `which`: no subprocess, and the same lookup rules the shell uses. */
export function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return paths.some((entry) => suffixes.some((ext) => existsSync(join(entry, binary + ext))));
}
