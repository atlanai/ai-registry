import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { posixRelative } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";

/** As `~/…`; real paths match too, so a symlinked home is recognized in both spellings. */
export function underHome(path: string): string {
  for (const home of new Set([resolve(homedir()), canonical(homedir())])) {
    if (path === home) return "~";
    if (path.startsWith(`${home}${sep}`)) return `~/${posixRelative(home, path)}`;
  }
  return path;
}
