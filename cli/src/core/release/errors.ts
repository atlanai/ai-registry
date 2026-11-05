import { messageOf } from "#adapter/errors.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

const RELEASE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.Error,
  ErrorCode.Invalid,
  ErrorCode.Integrity,
  ErrorCode.Unavailable,
]);

/**
 * A release check's failure with the command's hint attached and its code kept;
 * any other deliberate failure passes through unchanged.
 */
export function withReleaseHint(error: unknown, hint: string): AiregError {
  if (error instanceof AiregError) {
    if (error.hint !== undefined || !RELEASE_CODES.has(error.code)) return error;
    return new AiregError(error.message, { code: error.code, hint, cause: error.cause });
  }
  return new AiregError(messageOf(error), {
    hint,
    cause: error,
  });
}
