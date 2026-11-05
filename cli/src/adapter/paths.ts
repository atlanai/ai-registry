import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { stripTrailing } from "./text.ts";

const UNPRINTABLE = /\p{Cc}/u;
/**
 * A relative POSIX path every platform writes inside the folder it joins, with no `.git` segment.
 * A spelling later refused or rewritten must never reach the content key, or equal trees differ.
 */
export function isSafePath(path: string): boolean {
  if (path === "" || posix.isAbsolute(path) || UNPRINTABLE.test(path)) return false;
  // A backslash separates on Windows, and `:` names a drive or a Windows stream.
  if (path.includes("\\") || path.includes(":")) return false;
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && !isGitDir(segment),
    );
}

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
 * `env` with PATH cut to its absolute folders: a spawn resolves any other entry against its working
 * folder, which a registry may have written. Throws rather than empty PATH, which searches it too.
 */
export function withAbsolutePath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of pathKeys(env)) {
    const folders = absoluteFolders(env[key]);
    if (folders.length === 0) {
      throw new Error("No folder on PATH is absolute, so aireg runs no program from it.");
    }
    kept[key] = folders.join(delimiter);
  }
  return kept;
}

/** The names `env` gives PATH: on Windows, where names ignore case, `Path` too. */
function pathKeys(env: NodeJS.ProcessEnv): string[] {
  const windows = process.platform === "win32";
  return Object.keys(env).filter(
    (key) => env[key] !== undefined && (windows ? key.toUpperCase() === "PATH" : key === "PATH"),
  );
}

function absoluteFolders(path: string | undefined): string[] {
  return (path ?? "").split(delimiter).filter((folder) => isAbsolute(folder));
}

/** Cheap `which`: no subprocess, and only the folders a spawn would search. */
export function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = pathKeys(env).flatMap((key) => absoluteFolders(env[key]));
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return paths.some((entry) => suffixes.some((ext) => existsSync(join(entry, binary + ext))));
}

const SYSTEM_PROGRAMS = new Map([
  ["powershell", join("WindowsPowerShell", "v1.0", "powershell.exe")],
  ["reg", "reg.exe"],
  ["rundll32", "rundll32.exe"],
]);

/**
 * Windows tries a bare name in the working folder before PATH, so there this is its System32 copy
 * or the first match in PATH's absolute folders other than `cwd`. Elsewhere it is `command`.
 */
export function programPath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): string | undefined {
  if (process.platform !== "win32" || /[\\/:]/.test(command)) return command;
  const system = SYSTEM_PROGRAMS.get(command.toLowerCase());
  if (system !== undefined) return join(system32(env), system);
  const here = resolve(cwd).toLowerCase();
  return pathKeys(env)
    .flatMap((key) => absoluteFolders(env[key]))
    .filter((folder) => resolve(folder).toLowerCase() !== here)
    .flatMap((folder) => windowsCandidates(folder, command))
    .find((path) => existsSync(path));
}

function system32(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((each) => each.toUpperCase() === "SYSTEMROOT");
  const root = key === undefined ? undefined : env[key];
  return join(
    root !== undefined && /^[A-Za-z]:[\\/]/.test(root) ? root : "C:\\Windows",
    "System32",
  );
}

/** What a Windows spawn tries for `name`: itself when it has an extension, then .com and .exe. */
function windowsCandidates(folder: string, name: string): string[] {
  const names = [...(extname(name) === "" ? [] : [name]), `${name}.com`, `${name}.exe`];
  return names.map((each) => join(folder, each));
}
