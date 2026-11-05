import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SIGNALS } from "#cli/prompt/caller.ts";
import { envName } from "#core/env.ts";
import { HOME_DIR } from "#core/product.ts";
import { SCOPE_DIR } from "#core/store/paths.ts";

export interface Home {
  /** HOME and USERPROFILE. */
  dir: string;
  /** AIREG_HOME: aireg's own folder. */
  aireg: string;
  /** AIREG_USER_SCOPE: where `-g` installs. */
  scope: string;
  env: Record<string, string>;
}

/** The variables that keep a test off the real machine and out of CI-only behavior. */
export function homeEnv(dir: string): Record<string, string> {
  // Cleared: under GitHub Actions validate diffs against the base branch and setup edits
  // GITHUB_PATH, and inside a coding agent aireg prints differently from what a person sees.
  return {
    HOME: dir,
    USERPROFILE: dir,
    [envName("HOME")]: join(dir, HOME_DIR),
    [envName("USER_SCOPE")]: join(dir, SCOPE_DIR),
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    CODEX_HOME: join(dir, ".codex"),
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_RUNTIME_DIR: join(dir, ".run"),
    [envName("DISABLE_UPDATE_CHECK")]: "1",
    NO_COLOR: "1",
    GITHUB_ACTIONS: "",
    GITHUB_BASE_REF: "",
    ...Object.fromEntries(
      ["AI_AGENT", ...SIGNALS.flatMap((signal) => signal.env)].map((name) => [name, ""]),
    ),
  };
}

/** Creates a home at `dir`, or reuses the one already there. */
export async function makeHome(dir: string): Promise<Home> {
  const env = homeEnv(dir);
  await mkdir(dir, { recursive: true });
  // A runtime directory only this user can enter, as the daemon requires of one it uses.
  await mkdir(env.XDG_RUNTIME_DIR as string, { recursive: true, mode: 0o700 });
  return {
    dir,
    aireg: env[envName("HOME")] as string,
    scope: env[envName("USER_SCOPE")] as string,
    env,
  };
}
