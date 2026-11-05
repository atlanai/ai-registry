import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { posixRelative } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";

/**
 * Under the home directory as `~/…`, so a path reads the same from any folder.
 * Real paths are matched too, so a symlinked home is recognized in both spellings.
 */
export function underHome(path: string): string {
  for (const home of new Set([resolve(homedir()), canonical(homedir())])) {
    if (path === home) return "~";
    if (path.startsWith(`${home}${sep}`)) return `~/${posixRelative(home, path)}`;
  }
  return path;
}
