import { KINDS } from "#adapter/index.ts";
import { ITEM_OUTCOMES, RUN_STATES, RUN_TRIGGERS } from "#core/run/model.ts";
import { DISPOSITIONS } from "#core/sync/model.ts";
import { SYNC_OPERATIONS } from "#core/sync/policy.ts";

/** History is a cache, so any other layout is rebuilt. */
export const RUN_SCHEMA_VERSION = 1;

/** Newest runs kept per job. Older ones take their events with them. */
export const RUN_HISTORY_PER_JOB = 200;

/** Events kept per job across its newest runs: one run writes a row per artifact, so a run cap alone does not bound the file. */
export const RUN_EVENTS_PER_JOB = 50_000;

/** Newest one-off runs kept per account, which have no job to prune under. */
export const RUN_HISTORY_PER_ACCOUNT = 50;

/** The CHECK lists come from the same arrays the code reads, so they cannot drift apart. */
function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

export const RUN_SCHEMA = `
-- One execution of exactly one job. Counts are not stored: they are derived
-- from run_events, which is the only record of what happened to each item.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  -- Null for a one-off run started by hand rather than by a job.
  job_id TEXT,
  -- One run is one account, so history filters without joining the config.
  account_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN (${oneOf(RUN_TRIGGERS)})),
  state TEXT NOT NULL CHECK (state IN (${oneOf(RUN_STATES)})),
  -- The step a running run has reached; null once it is terminal. A free name
  -- rather than an enum: steps are declared, so aireg cannot list them.
  step TEXT,
  requested_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  deadline_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  -- Run-level failure only. A single bad artifact is an event, not this.
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  CHECK ((state IN ('queued', 'running') AND finished_at_ms IS NULL) OR
         (state NOT IN ('queued', 'running') AND finished_at_ms IS NOT NULL))
) STRICT;

-- What happened, item by item. A row with an artifact is one item's outcome;
-- one without is a run-level transition such as a phase change.
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  occurred_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  step TEXT,
  -- The item this is about: an artifact ref, or an adapter job's own key.
  artifact TEXT,
  kind TEXT CHECK (kind IS NULL OR kind IN (${oneOf(KINDS)})),
  -- What the two sides were found to be, and what was chosen about it. Kept
  -- apart because one is observed and the other is policy.
  disposition TEXT CHECK (disposition IS NULL OR disposition IN (${oneOf(DISPOSITIONS)})),
  operation TEXT CHECK (operation IS NULL OR operation IN (${oneOf(SYNC_OPERATIONS)})),
  -- How it settled, in the one vocabulary both planes share. This is what the
  -- derived counts group on; disposition and operation are artifacts-only detail.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (${oneOf(ITEM_OUTCOMES)})),
  -- Per-item failure, so one bad artifact does not fail the whole run.
  error_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  data_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (run_id, seq)
) STRICT;

-- NULLs are distinct in a UNIQUE index, which is exactly right here: it bounds
-- a job to one live run while leaving one-off runs unconstrained.
CREATE UNIQUE INDEX active_run_per_job ON runs(job_id) WHERE state IN ('queued', 'running');
CREATE INDEX runs_by_job_time ON runs(job_id, requested_at_ms DESC, id DESC);
CREATE INDEX runs_by_account_time ON runs(account_id, requested_at_ms DESC, id DESC);
CREATE INDEX runs_by_state_time ON runs(state, requested_at_ms DESC, id DESC);
CREATE INDEX run_events_by_item ON run_events(run_id, artifact);
-- Covers the per-run counts the scheduler asks for every second, so they read no table rows.
CREATE INDEX run_events_counts ON run_events(run_id, event_type, outcome);
`;

/** Dropped before the schema is recreated. */
export const RUN_TABLES = ["run_events", "runs"] as const;
