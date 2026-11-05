import type { Failure } from "./errors.ts";

/** Codes this client mints. A server's own codes are free-form and pass through. */
export const CLI_CODES = [
  "UNAUTHORIZED",
  "DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
  "INVALID",
  "DIGEST_MISMATCH",
  "SPEC_INVALID",
  "USAGE",
  "HOOK_REJECTED",
  "CONFIG_INVALID",
] as const;

export type CliCode = (typeof CLI_CODES)[number];

/** The code each failure is reported under when the server sent none. */
export const FAILURE_CODES = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "DENIED",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  unavailable: "UNAVAILABLE",
  invalid: "INVALID",
} as const satisfies Record<Failure, CliCode>;
