/**
 * Exit statuses are a contract scripts branch on, so never a literal at the call site. `Changed`
 * means something installed, or about to be, differs from what was recorded or published.
 */
export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
  Changed: 3,
  AuthRequired: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Stable codes `--json` reports for a failure; each maps to one exit status. Only adapters raise
 * `forbidden`; aireg itself never refuses access.
 */
export const ErrorCode = {
  Error: "error",
  Usage: "usage",
  NotFound: "not_found",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  Conflict: "conflict",
  Changed: "changed",
  Busy: "busy",
  Invalid: "invalid",
  Integrity: "integrity",
  Unavailable: "unavailable",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const EXIT: Record<ErrorCode, ExitCode> = {
  error: ExitCode.Error,
  usage: ExitCode.Usage,
  not_found: ExitCode.Error,
  unauthorized: ExitCode.AuthRequired,
  forbidden: ExitCode.AuthRequired,
  conflict: ExitCode.Error,
  changed: ExitCode.Changed,
  busy: ExitCode.Error,
  invalid: ExitCode.Error,
  integrity: ExitCode.Error,
  unavailable: ExitCode.Error,
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT[code];
}

export interface ErrorOptions {
  code?: ErrorCode;
  /** A second line telling the user what to do about it. */
  hint?: string | undefined;
  cause?: unknown;
}

/** Every failure aireg reports on purpose: a message, a stable code and an optional hint. */
export class AiregError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiregError";
    this.code = options.code ?? ErrorCode.Error;
    this.hint = options.hint;
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code);
  }
}
