import { join } from "node:path";
import { executableFile } from "#core/product.ts";
import { stateDir, toolHome } from "#core/store/paths.ts";

export function cliRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "cli");
}

export function versionDir(version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cliRoot(env), version);
}

export function currentLink(env: NodeJS.ProcessEnv = process.env): string {
  return join(cliRoot(env), "current");
}

/** The executable `current` links to: every install relinks it, so the path survives updates. */
export function currentBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(currentLink(env), executableFile());
}

/** One standalone executable per version; there is no package tree around it. */
export function versionBin(version: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(versionDir(version, env), executableFile());
}

export function binDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(toolHome(env), "bin");
}

/** What PATH finds: a shim on macOS and Linux, a copy of the current binary on Windows. */
export function shimPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(binDir(env), executableFile());
}

export function updateCheckPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "update-check.json");
}
