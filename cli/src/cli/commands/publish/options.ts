import { BUMPS, type Bump } from "#adapter/semver.ts";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

export interface Own extends Record<string, unknown> {
  to?: string;
  bump?: string;
  message?: string;
  "changed-since"?: string;
}

export function bumpOf(value: string | undefined): Bump | undefined {
  if (value === undefined) return undefined;
  if ((BUMPS as readonly string[]).includes(value)) return value as Bump;
  throw new AiregError(`Unknown --bump level ${quoted(value)}.`, {
    code: ErrorCode.Usage,
    hint: `Pass ${list(BUMPS, "or")}.`,
  });
}
