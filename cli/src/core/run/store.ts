import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Disposition } from "#core/sync/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import type {
  ItemOutcome,
  RunEvent,
  RunMode,
  RunRecord,
  RunState,
  RunTrigger,
  TerminalRunState,
} from "./model.ts";

export interface CreateRun {
  id: string;
  jobId?: string;
  accountId: string;
  configRevision: number;
  mode: RunMode;
  trigger: RunTrigger;
  requestedAtMs: number;
  deadlineAtMs: number;
}

export interface AppendRunEvent {
  occurredAtMs: number;
  /** One of `RunEventType`, or a type an extension's step records, as `JobHooks.event` allows. */
  eventType: string;
  step?: string;
  artifact?: string;
  kind?: ArtifactKind;
  disposition?: Disposition;
  operation?: SyncOperation;
  outcome?: ItemOutcome;
  errorCode?: string;
  retryable?: boolean;
  data?: unknown;
}

export interface FinishRun {
  state: TerminalRunState;
  finishedAtMs: number;
  errorCode?: string;
  retryable?: boolean;
}

/** Per read, of runs or of run events. */
export const MAX_PAGE_SIZE = 500;

export interface RunQuery {
  jobId?: string;
  accountId?: string;
  state?: RunState;
  limit?: number;
}

export interface RunStore {
  create(input: CreateRun): RunRecord;
  start(id: string, step: string, atMs: number): RunRecord;
  /** One write for the step and the event; undefined once the run stopped. */
  progress(id: string, step: string, event: AppendRunEvent): RunEvent | undefined;
  forgetJobs(live: ReadonlySet<string>): number;
  finish(id: string, result: FinishRun): RunRecord;
  get(id: string): RunRecord | undefined;
  activeJob(jobId: string): RunRecord | undefined;
  list(query?: RunQuery): RunRecord[];
  events(runId: string, afterEventId?: number, limit?: number): RunEvent[];
  /**
   * Failures, publishes held for review and settled folders: a large run is mostly
   * "examined" events, so a reader of these need not load it all.
   */
  notableEvents(runId: string): RunEvent[];
  lastEvent(runId: string): RunEvent | undefined;
  abandonActive(atMs: number): number;
  close(): void;
}
