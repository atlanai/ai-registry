import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, onTestFinished, vi } from "vitest";
import { carriedPaths, upstreamFacts } from "#core/console/runs.ts";
import { RunEventType } from "#core/run/model.ts";
import { test } from "#test/kit/fixtures.ts";
import { SqliteRunStore } from "./store.ts";
import {
  RUN_EVENTS_PER_JOB,
  RUN_HISTORY_PER_JOB,
  RUN_SCHEMA,
  RUN_SCHEMA_VERSION,
  RUN_TABLES,
} from "./store-schema.ts";

// The real budget takes 75,000 writes to cross; pruning is the same at any size.
vi.mock("./store-schema.ts", async (actual) => ({
  ...(await actual<typeof import("./store-schema.ts")>()),
  RUN_EVENTS_PER_JOB: 1_000,
}));

describe("SQLite run store", () => {
  test("commits run state and its ordered event stream together", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    store.create({
      id: "run_1",
      jobId: "job_1",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 100,
      deadlineAtMs: 1_000,
    });
    store.start("run_1", "resolving", 110);
    expect(() =>
      store.create({
        id: "run_2",
        jobId: "job_1",
        accountId: "acc_1",
        configRevision: 1,
        mode: "sync",
        trigger: "schedule",
        requestedAtMs: 115,
        deadlineAtMs: 1_000,
      }),
    ).toThrow();

    // Counts derive from item events.
    store.progress("run_1", "pull", {
      occurredAtMs: 111,
      eventType: RunEventType.ItemSettled,
      step: "pull",
      artifact: "a.txt",
      operation: "pull",
      outcome: "changed",
    });
    store.progress("run_1", "pull", {
      occurredAtMs: 112,
      eventType: RunEventType.ItemSettled,
      step: "pull",
      artifact: "b.txt",
      operation: "none",
      outcome: "skipped",
    });

    const finished = store.finish("run_1", { state: "succeeded", finishedAtMs: 120 });

    expect(finished.state).toBe("succeeded");
    expect(finished.counts).toEqual({
      examined: 2,
      changed: 1,
      skipped: 1,
      attention: 0,
      failed: 0,
    });
    expect(store.events("run_1", 0, 2)).toHaveLength(2);
    expect(store.lastEvent("run_1")?.eventType).toBe(RunEventType.Finished);
    expect(store.events("run_1").map(({ seq, eventType }) => [seq, eventType])).toEqual([
      [1, RunEventType.Queued],
      [2, RunEventType.Started],
      [3, RunEventType.ItemSettled],
      [4, RunEventType.ItemSettled],
      [5, RunEventType.Finished],
    ]);
    expect(() => store.finish("run_1", { state: "failed", finishedAtMs: 130 })).toThrow(
      "has already finished",
    );
    expect(store.abandonActive(140)).toBe(0);
    expect(
      store.events("run_1").filter(({ eventType }) => eventType === RunEventType.Finished),
    ).toHaveLength(1);
  });

  test("records an event type an extension's step names, as its hooks allow", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    store.create({
      id: "run_1",
      jobId: "job_1",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 100,
      deadlineAtMs: 1_000,
    });
    store.start("run_1", "export", 110);
    store.progress("run_1", "export", { occurredAtMs: 111, eventType: "trace.exported" });

    expect(store.events("run_1").map((event) => event.eventType)).toContain("trace.exported");
  });

  test("records an item of a kind an adapter declares", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    store.create({
      id: "run_1",
      jobId: "job_1",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 100,
      deadlineAtMs: 1_000,
    });
    store.start("run_1", "publish", 110);
    store.progress("run_1", "publish", {
      occurredAtMs: 111,
      eventType: RunEventType.ItemSettled,
      step: "publish",
      artifact: "accounts",
      kind: "knowledge",
      operation: "publish",
      outcome: "changed",
    });

    expect(store.events("run_1").map((event) => event.kind)).toContain("knowledge");
  });

  test("returns only the events the console reads, and they tell it everything", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    store.create({
      id: "run_1",
      jobId: "job_1",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 100,
      deadlineAtMs: 1_000,
    });
    store.start("run_1", "pull", 110);
    const item = (artifact: string, over: Record<string, unknown> = {}) =>
      store.progress("run_1", "pull", {
        occurredAtMs: 111,
        eventType: RunEventType.ItemSettled,
        step: "pull",
        artifact,
        operation: "none",
        outcome: "unchanged",
        ...over,
      });
    for (let index = 0; index < 50; index += 1) item(`same-${index}`);
    item("lost", { outcome: "failed", errorCode: "adapter_not_found", data: { detail: "gone" } });
    item("held", { disposition: "publish", operation: "publish", outcome: "attention" });
    item("folder", { data: { paths: [".claude/skills/folder"] } });
    item("odd", { data: { paths: "not a list" } });
    store.finish("run_1", { state: "attention", finishedAtMs: 120 });

    const all = store.events("run_1");
    const notable = store.notableEvents("run_1");
    expect(notable.map((event) => event.artifact)).toEqual(["lost", "held", "folder"]);
    expect(upstreamFacts(notable)).toEqual(upstreamFacts(all));
    const runs = (events: typeof all) => [{ job: "job", jobId: "job_1", settledAtMs: 120, events }];
    expect(carriedPaths(runs(notable))).toEqual(carriedPaths(runs(all)));
  });

  test("keeps a job's run history capped, pruning the oldest away", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    for (let index = 0; index < RUN_HISTORY_PER_JOB + 5; index += 1) {
      const id = `run_${index}`;
      store.create({
        id,
        jobId: "job_1",
        accountId: "acc_1",
        configRevision: 1,
        mode: "sync",
        trigger: "schedule",
        requestedAtMs: 1_000 + index,
        deadlineAtMs: 60_000,
      });
      store.finish(id, { state: "succeeded", finishedAtMs: 1_100 + index });
    }

    expect(store.get("run_0")).toBeUndefined();
    expect(store.get(`run_${RUN_HISTORY_PER_JOB + 4}`)).toBeDefined();
    expect(store.list({ jobId: "job_1", limit: 500 })).toHaveLength(RUN_HISTORY_PER_JOB);
    expect(store.events("run_0")).toHaveLength(0);
  });

  test("keeps a job's history inside its event budget, and always its newest run", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    const perRun = Math.ceil(RUN_EVENTS_PER_JOB / 2) + 1;
    for (const [index, id] of ["run_old", "run_mid", "run_new"].entries()) {
      store.create({
        id,
        jobId: "job_big",
        accountId: "acc_1",
        configRevision: 1,
        mode: "sync",
        trigger: "schedule",
        requestedAtMs: 1_000 + index,
        deadlineAtMs: 60_000,
      });
      store.start(id, "pulling", 1_000 + index);
      for (let item = 0; item < perRun; item += 1) {
        store.progress(id, "pull", {
          occurredAtMs: 1_000 + index,
          eventType: RunEventType.ItemSettled,
          step: "pull",
          artifact: `a${item}`,
          outcome: "unchanged",
        });
      }
      store.finish(id, { state: "succeeded", finishedAtMs: 1_100 + index });
    }
    expect(store.get("run_new")).toBeDefined();
    expect(store.get("run_mid")).toBeUndefined();
    expect(store.get("run_old")).toBeUndefined();
  });

  test("forgets a job's run history once it is no longer live", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    store.create({
      id: "run_kept",
      jobId: "job_kept",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 1,
      deadlineAtMs: 100,
    });
    store.create({
      id: "run_gone",
      jobId: "job_gone",
      accountId: "acc_1",
      configRevision: 1,
      mode: "sync",
      trigger: "manual",
      requestedAtMs: 2,
      deadlineAtMs: 100,
    });

    expect(store.forgetJobs(new Set(["job_kept"]))).toBe(1);
    expect(store.get("run_gone")).toBeUndefined();
    expect(store.get("run_kept")).toBeDefined();
  });
});

describe("file modes", () => {
  test.skipIf(process.platform === "win32")(
    "keeps the history owner-only, and tightens a folder left open",
    async ({ tmp }) => {
      const state = join(tmp, "state");
      await mkdir(state, { mode: 0o755 });
      await chmod(state, 0o755);
      const path = join(state, "aireg.db");
      const store = await SqliteRunStore.open(path);
      // Closed here, not in onTestFinished: that runs after the fixture removes tmp.
      try {
        store.create({
          id: "run_1",
          jobId: "job_1",
          accountId: "acc_1",
          configRevision: 1,
          mode: "sync",
          trigger: "manual",
          requestedAtMs: 100,
          deadlineAtMs: 1_000,
        });
        expect((await stat(state)).mode & 0o777).toBe(0o700);
        for (const file of [path, `${path}-wal`, `${path}-shm`]) {
          expect((await stat(file)).mode & 0o777, file).toBe(0o600);
        }
      } finally {
        store.close();
      }
    },
  );
});

describe("failed transactions", () => {
  test("reports the error that ended a transaction, not the rollback after it", async () => {
    const store = await SqliteRunStore.open(":memory:");
    onTestFinished(() => store.close());
    const exec = DatabaseSync.prototype.exec;
    const full = Object.assign(new Error("database or disk is full"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 13,
    });
    // SQLite rolls a transaction back by itself when the disk fills.
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql !== "COMMIT") return exec.call(this, sql);
      exec.call(this, "ROLLBACK");
      throw full;
    });
    onTestFinished(() => spy.mockRestore());
    expect(() =>
      store.create({
        id: "run_1",
        jobId: "job_1",
        accountId: "acc_1",
        configRevision: 1,
        mode: "sync",
        trigger: "manual",
        requestedAtMs: 100,
        deadlineAtMs: 1_000,
      }),
    ).toThrow(full);
  });
});

describe("schema versions", () => {
  test("creates only the tables it drops, so an adapter owns its own", () => {
    const created = [...RUN_SCHEMA.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1]);
    expect([...created].sort()).toEqual([...RUN_TABLES].sort());
  });

  test("rebuilds any layout but this one, since run history is only a cache", async ({ tmp }) => {
    const path = join(tmp, "other.db");
    const other = new DatabaseSync(path);
    other.exec(
      "CREATE TABLE runs (id TEXT PRIMARY KEY);" +
        " CREATE TABLE run_events (event_id INTEGER PRIMARY KEY); PRAGMA user_version=99;",
    );
    other.close();

    const store = await SqliteRunStore.open(path);
    try {
      expect(store.list()).toEqual([]);
    } finally {
      store.close();
    }
    const reopened = new DatabaseSync(path);
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const version = (reopened.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    reopened.close();
    expect(tables.map((row) => row.name)).toContain("runs");
    expect(tables.map((row) => row.name)).toContain("run_events");
    expect(version).toBe(RUN_SCHEMA_VERSION);
  });
});

describe("an unreadable history database", () => {
  test("is moved aside whole and replaced, so the daemon still starts", async ({ tmp }) => {
    const path = join(tmp, "aireg.db");
    (await SqliteRunStore.open(path)).close();
    const bytes = await readFile(path);
    bytes.fill(0xab, 100);
    await writeFile(path, bytes);
    const moved: string[] = [];
    const store = await SqliteRunStore.open(path, (to) => moved.push(to));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/aireg\.db\.corrupt-\d{8}T\d{6}Z$/);
    const aside = basename(moved[0] as string);
    expect((await readdir(tmp)).filter((name) => name.startsWith(aside))).toEqual([aside]);
    store.close();
  });
});
