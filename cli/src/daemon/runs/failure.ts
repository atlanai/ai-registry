import type { Job } from "#core/config/model.ts";
import { LeaseBusyError, LeaseError } from "#core/lease/errors.ts";
import {
  failureCode,
  isActive,
  isInterrupted,
  type RunCounts,
  RunErrorCode,
  type RunRecord,
  type TerminalRunState,
} from "#core/run/model.ts";
import { RunScopeError } from "#engine/sync/narrow.ts";

export const CANCELED = Symbol("canceled");
export const SHUTDOWN = Symbol("shutdown");
export const TIMED_OUT = Symbol("timed_out");

/** Enough history to reach the quiet ceiling; past it the multiplier is pinned. */
export const QUIET_LOOKBACK = 8;

export interface RunFailure {
  state: TerminalRunState;
  errorCode: RunErrorCode;
  retryable: boolean;
  interrupted: boolean;
}

export function classifyFailure(error: unknown, reason: unknown, changed: number): RunFailure {
  if (reason === CANCELED) {
    return {
      state: "canceled",
      errorCode: RunErrorCode.Canceled,
      retryable: false,
      interrupted: true,
    };
  }
  if (reason === SHUTDOWN) {
    return {
      state: "abandoned",
      errorCode: RunErrorCode.DaemonStopped,
      retryable: true,
      interrupted: true,
    };
  }
  if (reason === TIMED_OUT) {
    return {
      state: "timed_out",
      errorCode: RunErrorCode.TimedOut,
      retryable: true,
      interrupted: false,
    };
  }
  // An interruption, not a failure, so the failure streak is left alone.
  if (error instanceof LeaseBusyError) {
    return {
      state: "canceled",
      errorCode: RunErrorCode.ScopeBusy,
      retryable: true,
      interrupted: true,
    };
  }
  // Another writer took the scope mid-run; the next run starts from what it wrote.
  if (error instanceof LeaseError && error.reason === "lease_lost") {
    return {
      state: changed > 0 ? "partial" : "failed",
      errorCode: RunErrorCode.LeaseLost,
      retryable: true,
      interrupted: false,
    };
  }
  // A ref that reaches nothing is the caller's, so retrying it changes nothing.
  if (error instanceof RunScopeError) {
    return {
      state: "failed",
      errorCode: RunErrorCode.ScopeUnmatched,
      retryable: false,
      interrupted: false,
    };
  }
  return { state: changed > 0 ? "partial" : "failed", ...failureCode(error), interrupted: false };
}

/** The longest a job is ever left alone, however settled it looks. */
const QUIET_CEILING_MS = 30 * 60_000;
const RETRY_FLOOR_MS = 60_000;
const RETRY_CEILING_MS = 30 * 60_000;

/** Doubles from a minute per consecutive failure, to half an hour. */
export function retryBackoff(failures: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** (failures - 1));
}

/**
 * Derived from the job's own history rather than a stored schedule: a column
 * beside the runs is a second answer that can disagree. Newest first.
 */
export function dueAt(
  job: Job,
  recent: readonly RunRecord[],
  steady = false,
  now = Date.now(),
): number {
  const latest = recent.find((run) => run.finishedAtMs !== undefined);
  if (latest === undefined) return 0;
  // A run that finished "later" than now was timed before the clock stepped back.
  const settled = Math.min(latest.finishedAtMs as number, now);
  const interval = job.schedule.every * 1_000;

  if (latest.state === "abandoned") return 0;
  if (latest.state === "canceled") return settled + interval;

  const streak = failureStreak(recent);
  if (streak > 0) {
    return settled + Math.max(interval, retryBackoff(streak));
  }
  // A steady job is cheap and watches edits a person expects picked up soon.
  if (steady) return settled + interval;
  // The ceiling caps the growth, never the interval: a daily job must not be
  // pulled up to every half hour by its own backoff.
  return (
    settled +
    Math.max(interval, Math.min(interval * 2 ** repeats(recent, latest), QUIET_CEILING_MS))
  );
}

/** Consecutive newest runs that failed outright, ignoring interruptions. */
function failureStreak(recent: readonly RunRecord[]): number {
  let streak = 0;
  for (const run of recent) {
    if (run.finishedAtMs === undefined) continue;
    // An interrupted run is not a failure: a busy afternoon must not read as an outage.
    if (isInterrupted(run.state)) continue;
    if (run.state === "succeeded" || run.state === "attention") break;
    streak += 1;
  }
  return streak;
}

/** Consecutive earlier runs that reached the same conclusion, unedited. */
function repeats(recent: readonly RunRecord[], latest: RunRecord): number {
  const key = outcomeKey(latest.state as TerminalRunState, latest.counts);
  let count = 0;
  for (const previous of recent) {
    if (previous.id === latest.id) continue;
    // An edited job is a new question, whatever the last answer was.
    if (previous.configRevision !== latest.configRevision) break;
    if (isActive(previous.state)) break;
    if (outcomeKey(previous.state as TerminalRunState, previous.counts) !== key) break;
    count += 1;
  }
  return count;
}

function outcomeKey(state: TerminalRunState, counts: RunCounts): string {
  const { examined, changed, skipped, attention, failed } = counts;
  return [state, examined, changed, skipped, attention, failed].join(":");
}
