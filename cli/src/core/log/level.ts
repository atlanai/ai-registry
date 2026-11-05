import { list, quoted } from "#adapter/text.ts";
import { envName, setting } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isLevel, LEVELS, type Level } from "./model.ts";

/**
 * The daemon logs at `info` unconditionally: by the time anyone asks what a
 * scheduled run did, the file is the only evidence it ran at all.
 */
export const DAEMON_DEFAULT: Level = "info";

/**
 * A foreground run has a human and a `Printer` already talking to them, so the
 * diagnostic stream stays off until it is asked for.
 */
export const CLI_DEFAULT: Level | "off" = "off";

export interface LevelSource {
  /** `--log-level`, which beats the environment. */
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export const LEVEL_CHOICES = [...LEVELS, "off"] as const;

export class LogLevelError extends AiregError {
  /** `source` is where the value came from: the flag or the variable's name. */
  constructor(value: string, source: string) {
    super(`${source} takes ${list(LEVEL_CHOICES, "or")}, not ${quoted(value)}.`, {
      code: ErrorCode.Usage,
    });
    this.name = "LogLevelError";
  }
}

/**
 * `off` is a level a user can ask for, so `--log-level off` silences a daemon
 * without them having to find where the sink is wired.
 */
export function resolveLevel(
  fallback: Level | "off",
  { flag, env = process.env }: LevelSource = {},
): Level | "off" {
  const raw = flag ?? setting("LOG_LEVEL", env);
  const requested = raw?.trim().toLowerCase();
  if (requested === undefined || requested === "") return fallback;
  if (requested === "off") return "off";
  if (!isLevel(requested)) {
    throw new LogLevelError(
      raw as string,
      flag === undefined ? envName("LOG_LEVEL") : "--log-level",
    );
  }
  return requested;
}
