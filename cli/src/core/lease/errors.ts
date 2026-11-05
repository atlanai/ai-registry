import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Scope } from "#core/store/paths.ts";
import { scopeFlag, scopeName } from "#core/store/paths.ts";
import type { LeaseHolder } from "./holder.ts";

export function unlockCommand(scope: Scope): string {
  return `\`aireg unlock${scopeFlag(scope)}\``;
}

/** Thrown instead of waiting, so a scheduled run can skip rather than pile up. */
export class LeaseBusyError extends AiregError {
  readonly holder: LeaseHolder | undefined;

  constructor(holder: LeaseHolder | undefined, scope: Scope) {
    super(`Another aireg process is writing to ${scopeName(scope)}.`, {
      code: ErrorCode.Busy,
      hint: `Wait for it to finish, or run ${unlockCommand(scope)} if it has stopped.`,
    });
    this.name = "LeaseBusyError";
    this.holder = holder;
  }
}

export class LeaseError extends AiregError {
  /** Why the lease failed, for the daemon to tell a lost lease from a stuck one. */
  readonly reason: string | undefined;

  constructor(message: string, reason?: string, hint?: string) {
    super(message, { code: ErrorCode.Busy, hint });
    this.name = "LeaseError";
    this.reason = reason;
  }
}

export function stuckError(dir: string, code: string): LeaseError {
  return new LeaseError(
    `Could not remove the stale lock folder ${dir}.`,
    code,
    "Remove it by hand, then run the command again.",
  );
}
