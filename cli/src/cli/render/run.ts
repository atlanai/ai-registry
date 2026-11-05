import { sanitizeText } from "#adapter/text.ts";
import { ITEM_EVENT, RunErrorCode, type RunEvent, WARNING_EVENT } from "#core/run/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import type { Printer } from "#core/term/printer.ts";
import { underHome } from "./home.ts";

/** Where a run has got to, in words; a phase not listed is shown as it is named. */
const PHASES: Readonly<Record<string, string>> = {
  listing: "reading the registry",
  classifying: "comparing",
  applying: "applying changes",
  finalizing: "finishing",
};

/** What was done to an artifact that changed. */
const DONE: Partial<Record<SyncOperation, string>> = {
  pull: "pulled",
  "remove-local": "removed",
  publish: "published",
  archive: "archived",
  forget: "forgot",
};

/** Why a run ended, in words; the code itself stays in `--json`. */
const FAILED: Readonly<Record<string, string>> = {
  [RunErrorCode.Canceled]: "canceled",
  [RunErrorCode.DaemonStopped]: "stopped with the daemon",
  [RunErrorCode.DaemonRestarted]: "stopped when the daemon restarted",
  [RunErrorCode.TimedOut]: "took too long",
  [RunErrorCode.ScopeBusy]: "another command was writing",
  [RunErrorCode.LeaseLost]: "lost its write lock",
  [RunErrorCode.ScopeUnmatched]: "matched nothing",
  [RunErrorCode.SyncFailed]: "stopped by an error",
  [RunErrorCode.InReview]: "waiting for review",
  adapter_unauthorized: "the registry refused the sign-in",
  adapter_forbidden: "the registry refused access",
  adapter_not_found: "the registry has no such thing",
  adapter_conflict: "the registry changed meanwhile",
  adapter_unavailable: "the registry could not be reached",
  adapter_invalid: "the registry refused the request",
};

export function failureWords(code: string): string {
  return FAILED[code] ?? code.replaceAll("_", " ");
}

/** Wide enough for every word a line starts with, so the artifact names line up. */
const WIDTH = 9;

/** One settled artifact: what happened to it, its name, and why. */
export function itemLine(printer: Printer, event: RunEvent): string {
  const { style } = printer;
  const { origin } = (event.data ?? {}) as { origin?: unknown };
  const word =
    event.outcome === "changed"
      ? ((event.operation && DONE[event.operation]) ??
        (typeof origin === "string" ? "imported" : "changed"))
      : (event.outcome ?? "settled");
  const padded = word.padEnd(WIDTH);
  const verb =
    event.outcome === "failed"
      ? style.red(padded)
      : event.outcome === "attention"
        ? style.yellow(padded)
        : event.outcome === "changed"
          ? style.green(padded)
          : style.dim(padded);
  const why = detailOf(event);
  return `  ${verb}  ${event.artifact ?? ""}${why === undefined ? "" : style.dim(`  ${why}`)}`;
}

/** Why one needs you or failed, or which folder of yours one came from; a change needs no why. */
function detailOf(event: RunEvent): string | undefined {
  const { detail, origin } = (event.data ?? {}) as { detail?: unknown; origin?: unknown };
  const waiting = event.outcome === "attention" || event.outcome === "failed";
  if (waiting && typeof detail === "string") return sanitizeText(detail);
  if (typeof origin === "string") return `from ${underHome(origin)}`;
  return waiting && event.errorCode !== undefined ? failureWords(event.errorCode) : undefined;
}

/**
 * A followed run's event as a line. Progress inside a phase prints nothing: the
 * line each artifact settles with says what happened to it.
 */
export function eventLine(
  printer: Printer,
  event: RunEvent,
  /** What ended a failed run, from the daemon's log, where only the code was kept. */
  reason?: string,
): string | undefined {
  const { style } = printer;
  const label = (word: string) => word.padEnd(WIDTH);
  switch (event.eventType) {
    case "run.queued":
      return style.dim("  queued");
    case "run.started":
      return style.dim("  started");
    case "run.phase":
      return style.dim(`  ${PHASES[event.step ?? ""] ?? event.step ?? ""}`);
    case ITEM_EVENT:
      return itemLine(printer, event);
    case WARNING_EVENT: {
      const { message } = (event.data ?? {}) as { message?: unknown };
      return typeof message === "string"
        ? `  ${style.yellow(label("warning"))}  ${sanitizeText(message)}`
        : undefined;
    }
    case "run.finished": {
      const { state } = (event.data ?? {}) as { state?: unknown };
      const ended = typeof state === "string" ? state : "";
      const why =
        event.errorCode === undefined
          ? ""
          : style.dim(
              `  ${reason === undefined ? failureWords(event.errorCode) : sanitizeText(reason, 2000)}`,
            );
      return `  ${label("finished")}  ${ended}${why}`;
    }
    default:
      return undefined;
  }
}
