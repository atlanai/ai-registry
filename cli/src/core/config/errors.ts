import { AiregError, ErrorCode, type ErrorOptions } from "#core/errors.ts";
import { readers } from "#core/fields.ts";

export class ConfigError extends AiregError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? ErrorCode.Invalid });
    this.name = "ConfigError";
  }
}

/** The readers every part of config.yml is parsed with. */
export const fields = readers((message) => new ConfigError(message), "a mapping");

/** Only a stale snapshot is worth retrying, so callers can tell it from a malformed file. */
export class ConfigConflictError extends ConfigError {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Another aireg process changed config.yml first.`, {
      code: ErrorCode.Conflict,
      hint: "Run the command again.",
    });
    this.name = "ConfigConflictError";
    this.currentRevision = currentRevision;
  }
}
