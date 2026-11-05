import { AsyncLocalStorage } from "node:async_hooks";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import { NAME } from "./product.ts";

/**
 * Every setting aireg reads from its environment, as `AIREG_<name>`; docs/reference/environment.md
 * lists each public one. A `build` setting is stamped into a release; the built CLI never reads it.
 */
export const SETTINGS = {
  HOME: { public: true },
  USER_SCOPE: { public: true },
  VERSION: { public: true },
  LOG_LEVEL: { public: true },
  GIT_TIMEOUT_MS: { public: true },
  RELEASE_CHANNEL: { public: true },
  DISABLE_UPDATE_CHECK: { public: true },
  NO_MODIFY_PATH: { public: true },
  NO_DEFAULT_REGISTRIES: { public: true },
  SKIP_MIN_UPDATE: { public: false },
  DAEMON_SUPERVISOR: { public: false },
  RELEASE_VERSION: { public: false, build: true },
  RELEASE_ORIGIN: { public: false, build: true },
  RELEASE_KEYRING: { public: false, build: true },
  RELEASE_COMMIT: { public: false, build: true },
} as const;

export type Setting = keyof typeof SETTINGS;

export function envName(setting: Setting): string {
  return `${NAME.toUpperCase()}_${setting}`;
}

/** Whether any variable, aireg's or another tool's, holds a value other than blank. */
export function present(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** The trimmed value, or undefined when it is unset or blank. */
export function setting(name: Setting, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[envName(name)]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** A switch is on when it holds any value, `0` included, so every switch reads the same way. */
export function isSet(name: Setting, env: NodeJS.ProcessEnv = process.env): boolean {
  return setting(name, env) !== undefined;
}

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

/** How long one git operation may take: the setting in whole milliseconds, else five minutes. */
export function gitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = setting("GIT_TIMEOUT_MS", env);
  if (raw === undefined) return GIT_TIMEOUT_MS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value === 0) {
    throw new AiregError(
      `${envName("GIT_TIMEOUT_MS")} is ${quoted(raw)}, not a whole number of milliseconds.`,
      { code: ErrorCode.Usage, hint: `Set it to a number such as ${GIT_TIMEOUT_MS}, or unset it.` },
    );
  }
  return value;
}

/** Set by every CI service aireg knows; it then asks no questions and skips its update check. */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return present("CI", env);
}

export function inGitHubActions(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

const TOKEN_PREFIX = `${NAME.toUpperCase()}_TOKEN_`;

/** `AIREG_TOKEN_<ALIAS>`: one registry's token, so one machine can hold several. */
export function tokenVariable(alias: string): string {
  return `${TOKEN_PREFIX}${alias.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

/** `env` with no `AIREG_TOKEN_<NAME>` in it. */
export function withoutTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isTokenVariable(name)));
}

// Windows reads aireg_token_acme as AIREG_TOKEN_ACME, so the prefix matches in any case.
function isTokenVariable(name: string): boolean {
  return name.toUpperCase().startsWith(TOKEN_PREFIX);
}

/** Deletes every `AIREG_TOKEN_<NAME>` from this process's env, for one that must hold none. */
export function removeTokens(): void {
  for (const name of Object.keys(process.env)) if (isTokenVariable(name)) delete process.env[name];
}

const supplied = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/**
 * Runs `work` with these `AIREG_TOKEN_<NAME>` values in place of the environment's: how a
 * command hands its token to the daemon run it starts, in memory and for that run alone.
 */
export function withRegistryTokens<T>(tokens: Readonly<Record<string, string>>, work: () => T): T {
  return supplied.run(tokens, work);
}

/** The token set for this registry alone; a shared one would reach every host declared. */
export function registryToken(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = (supplied.getStore() ?? env)[tokenVariable(alias)]?.trim();
  return token === undefined || token === "" ? undefined : token;
}
