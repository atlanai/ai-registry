import type { ArtifactKind } from "#adapter/kinds.ts";
import type { ItemOutcome, RunCounts, RunEvent, RunRecord, RunState } from "#core/run/model.ts";
import type { Disposition } from "#core/sync/model.ts";
import type { SyncOperation } from "#core/sync/policy.ts";

type Row = Record<string, unknown>;

export function toRun(row: Row, counts: RunCounts): RunRecord {
  return {
    id: String(row.id),
    jobId: optionalText(row.job_id),
    accountId: String(row.account_id),
    configRevision: integer(row.config_revision),
    mode: row.mode as RunRecord["mode"],
    trigger: row.trigger as RunRecord["trigger"],
    state: row.state as RunState,
    step: optionalText(row.step),
    requestedAtMs: integer(row.requested_at_ms),
    startedAtMs: optionalInteger(row.started_at_ms),
    deadlineAtMs: integer(row.deadline_at_ms),
    finishedAtMs: optionalInteger(row.finished_at_ms),
    counts,
    errorCode: optionalText(row.error_code),
    retryable: row.retryable === 1,
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("The run history holds an invalid number.");
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : integer(value);
}

export function toCounts(row: Row): RunCounts {
  return {
    examined: integer(row.examined),
    changed: integer(row.changed),
    skipped: integer(row.skipped),
    attention: integer(row.attention),
    failed: integer(row.failed),
  };
}

export function toEvent(row: Row): RunEvent {
  return {
    id: integer(row.id),
    runId: String(row.run_id),
    seq: integer(row.seq),
    occurredAtMs: integer(row.occurred_at_ms),
    eventType: String(row.event_type),
    step: optionalText(row.step),
    artifact: optionalText(row.artifact),
    kind: optionalText(row.kind) as ArtifactKind | undefined,
    disposition: optionalText(row.disposition) as Disposition | undefined,
    operation: optionalText(row.operation) as SyncOperation | undefined,
    outcome: optionalText(row.outcome) as ItemOutcome | undefined,
    errorCode: optionalText(row.error_code),
    retryable: row.retryable === 1,
    data: json(row.data_json),
  };
}

function json(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("The run history holds invalid JSON.");
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error("The run history holds invalid JSON.", { cause });
  }
}
