import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { PRIVATE_DIR, PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { DATABASE_FILE } from "#core/product.ts";
import {
  EMPTY_RUN_COUNTS,
  type RunCounts,
  RunErrorCode,
  type RunEvent,
  RunEventType,
  type RunRecord,
} from "#core/run/model.ts";
import type { AppendRunEvent, CreateRun, FinishRun, RunQuery, RunStore } from "#core/run/store.ts";
import { stateDir } from "#core/store/paths.ts";
import { MAX_PAGE_SIZE } from "#daemon/rpc/methods.ts";
import { toCounts, toEvent, toRun } from "./store-rows.ts";
import {
  ACTIVE,
  RUN_EVENTS_PER_JOB,
  RUN_HISTORY_PER_ACCOUNT,
  RUN_HISTORY_PER_JOB,
  RUN_SCHEMA,
  RUN_SCHEMA_VERSION,
  RUN_TABLES,
} from "./store-schema.ts";

type Row = Record<string, unknown>;
const SQLITE_BUILTIN = ["node", "sqlite"].join(":");

const RUN_COLUMNS = `
  id, job_id, account_id, config_revision, mode, trigger, state, step,
  requested_at_ms, started_at_ms, deadline_at_ms, finished_at_ms, error_code, retryable`;

const EVENT_COLUMNS = `
  id, run_id, seq, occurred_at_ms, event_type, step, artifact, kind,
  disposition, operation, outcome, error_code, retryable, data_json`;

/**
 * Counts are an aggregate over the events, so what a run reports and what it
 * recorded cannot drift apart.
 */
const COUNTS_SELECT = `
  SELECT run_id,
    COUNT(*) AS examined,
    SUM(CASE WHEN outcome = 'changed' THEN 1 ELSE 0 END) AS changed,
    SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
    SUM(CASE WHEN outcome = 'attention' THEN 1 ELSE 0 END) AS attention,
    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed
  FROM run_events
  WHERE event_type = '${RunEventType.ItemSettled}'`;

function encoded(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function scalar(value: string | undefined): string | null {
  return value ?? null;
}

export function runDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), DATABASE_FILE);
}

/** SQLITE_CORRUPT and SQLITE_NOTADB, the two ways a database file is past reading. */
function unreadable(error: unknown): boolean {
  const { errcode, message } = (error ?? {}) as { errcode?: unknown; message?: unknown };
  if (typeof errcode === "number" && [11, 26].includes(errcode & 0xff)) return true;
  return typeof message === "string" && /malformed|not a database/i.test(message);
}

export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;
  /** Each statement compiled once; a run of thousands of events reuses them. */
  readonly #statements = new Map<string, StatementSync>();
  /** The next sequence number of each run written to since this store opened. */
  readonly #sequences = new Map<string, number>();

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * History is a cache, so a database SQLite cannot read is moved aside and a
   * new one started, rather than keeping the daemon from ever starting.
   */
  static async open(
    path: string,
    movedAside: (to: string) => void = () => {},
  ): Promise<SqliteRunStore> {
    try {
      return await SqliteRunStore.#openAt(path);
    } catch (error) {
      if (path === ":memory:" || !unreadable(error)) throw error;
      const to = `${path}.corrupt-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`;
      for (const suffix of ["", "-wal", "-shm"]) {
        await rename(`${path}${suffix}`, `${to}${suffix}`).catch(() => {});
      }
      movedAside(to);
      return SqliteRunStore.#openAt(path);
    }
  }

  static async #openAt(path: string): Promise<SqliteRunStore> {
    const onDisk = path !== ":memory:";
    if (onDisk) {
      await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR });
      // Also tightens a folder left at 0755.
      await ownerOnly(dirname(path), PRIVATE_DIR);
    }
    const { DatabaseSync } = (await import(SQLITE_BUILTIN)) as typeof import("node:sqlite");
    const database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    try {
      await prepare(database, path, onDisk);
    } catch (error) {
      // An open handle would keep SQLite writing beside a file that is then moved aside.
      database.close();
      throw error;
    }
    return new SqliteRunStore(database);
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite already rolled back after SQLITE_FULL, and a second error must not hide the first.
      if (this.#database.isTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // The original error says what went wrong.
        }
      }
      throw error;
    }
  }

  #counts(runIds: readonly string[]): Map<string, RunCounts> {
    if (runIds.length === 0) return new Map();
    const holes = runIds.map(() => "?").join(", ");
    const rows = this.#prepare(`${COUNTS_SELECT} AND run_id IN (${holes}) GROUP BY run_id`).all(
      ...runIds,
    ) as Row[];
    return new Map(rows.map((row) => [String(row.run_id), toCounts(row)]));
  }

  #hydrate(rows: Row[]): RunRecord[] {
    const counts = this.#counts(rows.map((row) => String(row.id)));
    return rows.map((row) => toRun(row, counts.get(String(row.id)) ?? EMPTY_RUN_COUNTS));
  }

  #event(runId: string, event: AppendRunEvent): RunEvent {
    const sequence =
      this.#sequences.get(runId) ??
      Number(
        (
          this.#prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
          ).get(runId) as Row
        ).seq,
      );
    const inserted = this.#prepare(
      `INSERT INTO run_events
          (run_id, seq, occurred_at_ms, event_type, step, artifact, kind,
           disposition, operation, outcome, error_code, retryable, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      sequence,
      event.occurredAtMs,
      event.eventType,
      scalar(event.step),
      scalar(event.artifact),
      scalar(event.kind),
      scalar(event.disposition),
      scalar(event.operation),
      scalar(event.outcome),
      scalar(event.errorCode),
      event.retryable === true ? 1 : 0,
      encoded(event.data),
    );
    this.#sequences.set(runId, sequence + 1);
    const row = this.#prepare(`SELECT ${EVENT_COLUMNS} FROM run_events WHERE id = ?`).get(
      inserted.lastInsertRowid,
    ) as Row;
    return toEvent(row);
  }

  create(input: CreateRun): RunRecord {
    return this.#transaction(() => {
      this.#prepare(
        `INSERT INTO runs (
            id, job_id, account_id, config_revision, mode, trigger,
            state, requested_at_ms, deadline_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        input.id,
        scalar(input.jobId),
        input.accountId,
        input.configRevision,
        input.mode,
        input.trigger,
        input.requestedAtMs,
        input.deadlineAtMs,
      );
      this.#event(input.id, { occurredAtMs: input.requestedAtMs, eventType: RunEventType.Queued });
      return this.get(input.id) as RunRecord;
    });
  }

  start(id: string, step: string, atMs: number): RunRecord {
    return this.#transaction(() => {
      const changed = this.#prepare(
        "UPDATE runs SET state = 'running', step = ?, started_at_ms = ? WHERE id = ? AND state = 'queued'",
      ).run(step, atMs, id).changes;
      if (changed !== 1) {
        throw new AiregError(`Run ${quoted(id)} is not queued.`, { code: ErrorCode.Conflict });
      }
      this.#event(id, { occurredAtMs: atMs, eventType: RunEventType.Started, step });
      return this.get(id) as RunRecord;
    });
  }

  progress(id: string, step: string, event: AppendRunEvent): RunEvent | undefined {
    return this.#transaction(() => {
      const moved = this.#prepare(
        "UPDATE runs SET step = ? WHERE id = ? AND state = 'running'",
      ).run(step, id).changes;
      return moved === 1 ? this.#event(id, event) : undefined;
    });
  }

  /** A deleted job leaves its run history behind, which nothing else reclaims. */
  forgetJobs(live: ReadonlySet<string>): number {
    const rows = this.#prepare(
      "SELECT DISTINCT job_id FROM runs WHERE job_id IS NOT NULL",
    ).all() as { job_id: string }[];
    const stale = rows.map(({ job_id }) => job_id).filter((id) => !live.has(id));
    for (const id of stale) {
      this.#prepare("DELETE FROM runs WHERE job_id = ?").run(id);
    }
    return stale.length;
  }

  /** One-off runs have no job to prune under, so they are capped per account. */
  #prune(run: RunRecord): void {
    if (run.jobId === undefined) {
      this.#prepare(
        `DELETE FROM runs WHERE job_id IS NULL AND account_id = ? AND id NOT IN (
             SELECT id FROM runs WHERE job_id IS NULL AND account_id = ?
             ORDER BY requested_at_ms DESC, id DESC LIMIT ?
           )`,
      ).run(run.accountId, run.accountId, RUN_HISTORY_PER_ACCOUNT);
      return;
    }
    // The newest runs, up to the run cap and the event budget; the newest is always kept.
    this.#prepare(
      `DELETE FROM runs WHERE job_id = ? AND id NOT IN (
           SELECT id FROM (
             SELECT id,
               ROW_NUMBER() OVER newest AS place,
               SUM((SELECT COUNT(*) FROM run_events WHERE run_id = runs.id)) OVER newest AS events
             FROM runs WHERE job_id = ?
             WINDOW newest AS (ORDER BY requested_at_ms DESC, id DESC)
           ) WHERE place = 1 OR (place <= ? AND events <= ?)
         )`,
    ).run(run.jobId, run.jobId, RUN_HISTORY_PER_JOB, RUN_EVENTS_PER_JOB);
    this.#database.exec("PRAGMA incremental_vacuum;");
  }

  finish(id: string, result: FinishRun): RunRecord {
    // A finished run takes no more events, so its counter is not kept.
    this.#sequences.delete(id);
    return this.#transaction(() => {
      const changed = this.#prepare(
        `UPDATE runs SET state = ?, step = NULL, finished_at_ms = ?, error_code = ?, retryable = ?
           WHERE id = ? AND ${ACTIVE}`,
      ).run(
        result.state,
        result.finishedAtMs,
        scalar(result.errorCode),
        result.retryable === true ? 1 : 0,
        id,
      ).changes;
      if (changed !== 1) {
        throw new AiregError(`Run ${quoted(id)} has already finished, or does not exist.`, {
          code: ErrorCode.Conflict,
        });
      }
      this.#event(id, {
        occurredAtMs: result.finishedAtMs,
        eventType: RunEventType.Finished,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        retryable: result.retryable === true,
        data: { state: result.state },
      });
      const record = this.get(id) as RunRecord;
      this.#prune(record);
      return record;
    });
  }

  get(id: string): RunRecord | undefined {
    const row = this.#prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id);
    return row === undefined ? undefined : this.#hydrate([row as Row])[0];
  }

  activeJob(jobId: string): RunRecord | undefined {
    const row = this.#prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
         WHERE job_id = ? AND ${ACTIVE}
         ORDER BY requested_at_ms DESC, id DESC LIMIT 1`,
    ).get(jobId);
    return row === undefined ? undefined : this.#hydrate([row as Row])[0];
  }

  list(query: RunQuery = {}): RunRecord[] {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE_SIZE);
    const rows = this.#prepare(
      `SELECT ${RUN_COLUMNS} FROM runs
         WHERE (? IS NULL OR job_id = ?) AND (? IS NULL OR account_id = ?)
           AND (? IS NULL OR state = ?)
         ORDER BY requested_at_ms DESC, id DESC LIMIT ?`,
    ).all(
      scalar(query.jobId),
      scalar(query.jobId),
      scalar(query.accountId),
      scalar(query.accountId),
      scalar(query.state),
      scalar(query.state),
      limit,
    ) as Row[];
    return this.#hydrate(rows);
  }

  events(runId: string, afterEventId = 0, limit?: number): RunEvent[] {
    const query = `SELECT ${EVENT_COLUMNS} FROM run_events
      WHERE run_id = ? AND id > ? ORDER BY seq`;
    const rows =
      limit === undefined
        ? this.#prepare(query).all(runId, afterEventId)
        : this.#prepare(`${query} LIMIT ?`).all(runId, afterEventId, limit);
    return rows.map((row) => toEvent(row as Row));
  }

  notableEvents(runId: string): RunEvent[] {
    const rows = this.#prepare(
      `SELECT ${EVENT_COLUMNS} FROM run_events
         WHERE run_id = ? AND (
           error_code IS NOT NULL
           OR (disposition = 'publish' AND operation = 'publish' AND outcome = 'attention')
           OR (event_type = ? AND json_type(data_json, '$.paths') = 'array')
         )
         ORDER BY seq`,
    ).all(runId, RunEventType.ItemSettled);
    return rows.map((row) => toEvent(row as Row));
  }

  lastEvent(runId: string): RunEvent | undefined {
    const row = this.#prepare(
      `SELECT ${EVENT_COLUMNS} FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
    ).get(runId);
    return row === undefined ? undefined : toEvent(row as Row);
  }

  abandonActive(atMs: number): number {
    return this.#transaction(() => {
      const rows = this.#prepare(`SELECT id FROM runs WHERE ${ACTIVE}`).all() as { id: string }[];
      const changed = Number(
        this.#prepare(
          `UPDATE runs SET state = 'abandoned', step = NULL, finished_at_ms = ?,
              error_code = ?, retryable = 1
             WHERE ${ACTIVE}`,
        ).run(atMs, RunErrorCode.DaemonRestarted).changes,
      );
      for (const { id } of rows) {
        this.#event(id, {
          occurredAtMs: atMs,
          eventType: RunEventType.Finished,
          errorCode: RunErrorCode.DaemonRestarted,
          retryable: true,
          data: { state: "abandoned" },
        });
      }
      return changed;
    });
  }

  close(): void {
    this.#database.close();
  }
}

/** Sets the journal and the schema, rebuilding history whose layout is not this one. */
async function prepare(database: DatabaseSync, path: string, onDisk: boolean): Promise<void> {
  // NORMAL under WAL never corrupts the database; a power cut may lose the newest
  // events, which is acceptable for history and spares an fsync per event.
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA trusted_schema=OFF;");
  // SQLite gives a later -wal or -shm the database's own mode.
  if (onDisk) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) await ownerOnly(file, PRIVATE_FILE);
  }
  const version = (database.prepare("PRAGMA user_version").get() as Row).user_version;
  // History is a cache, so any layout but this one is rebuilt, never migrated.
  if (version !== RUN_SCHEMA_VERSION) {
    const drops = RUN_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join(" ");
    database.exec("PRAGMA auto_vacuum=INCREMENTAL;");
    database.exec(
      `BEGIN IMMEDIATE; ${drops} ${RUN_SCHEMA} PRAGMA user_version=${RUN_SCHEMA_VERSION}; COMMIT;`,
    );
  }
}

/** The history holds paths, session ids and skill names: owner-only, like the logs. */
async function ownerOnly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
