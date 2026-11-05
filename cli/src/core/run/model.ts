import { isRetryable } from "#adapter/errors.ts";
import { type Failure, isAdapterError } from "#adapter/index.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Disposition } from "#core/sync/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";

export const RUN_MODES = ["sync", "pull", "publish"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

export const RUN_TRIGGERS = ["manual", "schedule", "startup"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "attention",
  "partial",
  "failed",
  "timed_out",
  "canceled",
  "abandoned",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ACTIVE_RUN_STATES = ["queued", "running"] as const satisfies readonly RunState[];
type ActiveRunState = (typeof ACTIVE_RUN_STATES)[number];
export type TerminalRunState = Exclude<RunState, ActiveRunState>;

/** Ended without doing its work, as opposed to one that was stopped or did part of it. */
const FAILED_RUN_STATES = ["failed", "timed_out"] as const satisfies readonly TerminalRunState[];

export function isActive(state: RunState): state is ActiveRunState {
  return (ACTIVE_RUN_STATES as readonly RunState[]).includes(state);
}

/** Every state but the active ones, so a state added to `RUN_STATES` is terminal by default. */
export function isTerminal(state: RunState): state is TerminalRunState {
  return !isActive(state);
}

export function isFailed(state: RunState): boolean {
  return (FAILED_RUN_STATES as readonly RunState[]).includes(state);
}

/** Stopped before its work was done: canceled, or cut off by the daemon stopping. */
export function isInterrupted(state: RunState): boolean {
  return state === "canceled" || state === "abandoned";
}

/** An adapter's refusal is `adapter_<failure>`. `in_review` means waiting, not refused. */
export const RunErrorCode = {
  Canceled: "run_canceled",
  DaemonStopped: "daemon_stopped",
  DaemonRestarted: "daemon_restarted",
  TimedOut: "run_timed_out",
  ScopeBusy: "scope_busy",
  LeaseLost: "lease_lost",
  ScopeUnmatched: "run_scope_unmatched",
  SyncFailed: "sync_failed",
  InReview: "in_review",
} as const;

export type RunErrorCode = (typeof RunErrorCode)[keyof typeof RunErrorCode] | `adapter_${Failure}`;

/** The code an error fails a run or an item with when nothing more specific applies. */
export function failureCode(error: unknown): { errorCode: RunErrorCode; retryable: boolean } {
  if (isAdapterError(error)) {
    return { errorCode: `adapter_${error.failure}`, retryable: isRetryable(error) };
  }
  return { errorCode: RunErrorCode.SyncFailed, retryable: false };
}

/**
 * How one item settled, in the one vocabulary both planes share. An artifact's
 * `disposition` and `operation` are plane detail; this is what a count is taken over.
 */
export const ITEM_OUTCOMES = ["changed", "unchanged", "skipped", "attention", "failed"] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

/** One item's result, reported by the executor rather than inferred from a data bag. */
export interface ItemSettled {
  outcome: ItemOutcome;
  kind?: ArtifactKind;
  disposition?: Disposition;
  operation?: SyncOperation;
  errorCode?: string;
  retryable?: boolean;
}

/** `ItemSettled` is what counts are taken over. `Warning` data is `{ message, hint? }`. */
export const RunEventType = {
  Queued: "run.queued",
  Started: "run.started",
  Phase: "run.phase",
  Progress: "artifact.progress",
  ItemSettled: "item.settled",
  Warning: "run.warning",
  Finished: "run.finished",
} as const;
export type RunEventType = (typeof RunEventType)[keyof typeof RunEventType];

/** In order. */
const RUN_PHASES = ["listing", "classifying", "applying", "finalizing"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export function isRunPhase(value: string | undefined): value is RunPhase {
  return (RUN_PHASES as readonly (string | undefined)[]).includes(value);
}

/**
 * Derived from `run_events`, never stored: a count written beside the events it
 * summarizes is a second answer that can disagree with the first.
 */
export interface RunCounts {
  examined: number;
  changed: number;
  skipped: number;
  attention: number;
  failed: number;
}

export const EMPTY_RUN_COUNTS: RunCounts = Object.freeze({
  examined: 0,
  changed: 0,
  skipped: 0,
  attention: 0,
  failed: 0,
});

export interface RunRecord {
  id: string;
  /** Absent for a one-off run started by hand rather than by a job. */
  jobId: string | undefined;
  /** One run is one account, so history filters without joining the config. */
  accountId: string;
  /** The config this run read. A later edit is a different question. */
  configRevision: number;
  mode: RunMode;
  trigger: RunTrigger;
  state: RunState;
  /** The step a running run has reached; absent once it is terminal. */
  step: string | undefined;
  requestedAtMs: number;
  startedAtMs: number | undefined;
  deadlineAtMs: number;
  finishedAtMs: number | undefined;
  counts: RunCounts;
  /** Run-level failure only. A single bad artifact is an event, not this. */
  errorCode: string | undefined;
  retryable: boolean;
}

export interface RunEvent {
  id: number;
  runId: string;
  seq: number;
  occurredAtMs: number;
  /** A daemon of another version may send a type this one does not know. */
  eventType: string;
  step: string | undefined;
  /** The item this is about, as the step that emitted it names it. */
  artifact: string | undefined;
  kind: ArtifactKind | undefined;
  /** What the two sides were found to be. Observed, not chosen. */
  disposition: Disposition | undefined;
  /** What policy chose about that. */
  operation: SyncOperation | undefined;
  /** Set on an item event; absent on a run transition. */
  outcome: ItemOutcome | undefined;
  /** Per-item failure, so one bad artifact does not fail the whole run. */
  errorCode: string | undefined;
  retryable: boolean;
  data: unknown;
}
