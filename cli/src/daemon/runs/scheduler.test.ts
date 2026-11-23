import { describe, expect, vi } from "vitest";
import type { Job, RegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { EMPTY_RUN_COUNTS, type RunRecord } from "#core/run/model.ts";
import type { RunStore } from "#core/run/store.ts";
import { test } from "#test/kit/fixtures.ts";
import type { SyncRunner } from "./runner.ts";
import { JobScheduler } from "./scheduler.ts";

function job(id: string, root: string, enabled = true): Job {
  return {
    id,
    account: "acc_demo",
    schedule: { every: 300, enabled },
    steps: [{ name: "pull", kind: "pull", needs: [], root, select: [], policy: "on", extra: {} }],
  };
}

function config(jobs: Job[], paused = false): RegistryConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    paused,
    telemetry: true,
    defaults: {},
    adapters: {},
    accounts: [{ id: "acc_demo", registry: "personal" }],
    jobs,
    hooks: [],
  };
}

function storeReturning(
  runs: Record<string, RunRecord[]>,
  active: readonly RunRecord[] = [],
): RunStore {
  return {
    list: ({ jobId, state }: { jobId?: string; state?: string }) => {
      if (jobId !== undefined) return runs[jobId] ?? [];
      return active.filter((run) => run.state === state);
    },
    forgetJobs: () => 0,
  } as unknown as RunStore;
}

/** A run still going, of another job, started by `trigger`. */
function activeRun(index: number, trigger: RunRecord["trigger"]): RunRecord {
  return { id: `run_${index}`, jobId: `other_${index}`, trigger, state: "running" } as RunRecord;
}

/** The job's one earlier run, finished at `finishedAtMs`. */
function finishedRun(jobId: string, finishedAtMs: number): RunRecord {
  return {
    id: `run_${jobId}`,
    jobId,
    accountId: "acc_demo",
    configRevision: 0,
    mode: "sync",
    trigger: "schedule",
    state: "succeeded",
    step: undefined,
    requestedAtMs: finishedAtMs,
    startedAtMs: finishedAtMs,
    deadlineAtMs: finishedAtMs,
    finishedAtMs,
    counts: EMPTY_RUN_COUNTS,
    errorCode: undefined,
    retryable: false,
  };
}

describe("JobScheduler", () => {
  test("starts an enabled job on startup and passes over a disabled one", async ({ home }) => {
    await writeConfig(
      config([job("watch_off", home.aireg, false), job("watch_on", home.aireg)]),
      0,
    );
    const start = vi.fn(async () => ({}) as RunRecord);
    const scheduler = new JobScheduler(storeReturning({}), { start } as unknown as SyncRunner);

    scheduler.start();
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalled());
    } finally {
      scheduler.stop();
    }

    expect(start.mock.calls).toEqual([["watch_on", "sync", "startup"]]);
  });

  test("schedules nothing while paused", async ({ home }) => {
    await writeConfig(config([job("watch_on", home.aireg)], true), 0);
    const start = vi.fn(async () => ({}) as RunRecord);

    await new JobScheduler(storeReturning({}), { start } as unknown as SyncRunner).tick();

    expect(start).not.toHaveBeenCalled();
  });

  test("considers every job even when an earlier one cannot start", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg), job("watch_b", home.aireg)]), 0);
    const started: string[] = [];
    const runner = {
      start: vi.fn(async (jobId: string) => {
        if (jobId === "watch_a") throw new Error("Another job is already syncing this scope");
        started.push(jobId);
        return {} as RunRecord;
      }),
    } as unknown as SyncRunner;

    await new JobScheduler(storeReturning({}), runner).tick();

    expect(started).toEqual(["watch_b"]);
  });

  test("holds a due job back while four scheduled runs are going", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    const busy = [0, 1, 2, 3].map((index) => activeRun(index, "schedule"));

    await new JobScheduler(storeReturning({}, busy), { start } as unknown as SyncRunner).tick();

    expect(start).not.toHaveBeenCalled();
  });

  test("does not hold a job back for runs a person started", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    const busy = [0, 1, 2, 3].map((index) => activeRun(index, "manual"));

    await new JobScheduler(storeReturning({}, busy), { start } as unknown as SyncRunner).tick();

    expect(start.mock.calls).toEqual([["watch_a", "sync", "startup"]]);
  });

  test("starts the job that has waited longest first", async ({ home }) => {
    await writeConfig(config([job("watch_recent", home.aireg), job("watch_late", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    // Both are past their 300 s interval; watch_late by an hour more.
    const now = Date.now();
    const store = storeReturning({
      watch_recent: [finishedRun("watch_recent", now - 301_000)],
      watch_late: [finishedRun("watch_late", now - 301_000 - 3_600_000)],
    });

    await new JobScheduler(store, { start } as unknown as SyncRunner).tick();

    expect(start.mock.calls).toEqual([["watch_late", "sync", "schedule"]]);
  });

  test("backs a failing job off instead of retrying it every tick", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => {
      throw new Error("Job account not found");
    });
    const scheduler = new JobScheduler(storeReturning({}), { start } as unknown as SyncRunner);

    // Without a deferral each tick retries: a 1 Hz hot loop.
    await scheduler.tick();
    await scheduler.tick();

    expect(start.mock.calls.length).toBe(1);
  });

  test("skips a job whose next run is not yet due", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    const store = storeReturning({
      watch_a: [
        {
          id: "run_1",
          jobId: "watch_a",
          accountId: "acc_demo",
          configRevision: 0,
          mode: "sync",
          trigger: "schedule",
          state: "succeeded",
          step: "pull",
          requestedAtMs: Date.now(),
          startedAtMs: Date.now(),
          deadlineAtMs: Date.now() + 60_000,
          finishedAtMs: Date.now(),
          counts: EMPTY_RUN_COUNTS,
          errorCode: undefined,
          retryable: false,
        },
      ],
    });

    await new JobScheduler(store, { start } as unknown as SyncRunner).tick();

    expect(start).not.toHaveBeenCalled();
  });

  test("skips a job whose run is still active", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    const store = storeReturning({
      watch_a: [{ id: "run_1", state: "running" } as RunRecord],
    });

    await new JobScheduler(store, { start } as unknown as SyncRunner).tick();

    expect(start).not.toHaveBeenCalled();
  });

  test("runs a job whose step kind is steady on its interval, where a quiet one would wait", async ({
    home,
  }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    // Four identical runs, the last one interval ago: a quiet job backs off to 30 minutes.
    const finishedAtMs = Date.now() - 301_000;
    const quiet = Array.from({ length: 4 }, (_, index) => ({
      id: `run_${index}`,
      jobId: "watch_a",
      accountId: "acc_demo",
      configRevision: 0,
      mode: "sync",
      trigger: "schedule",
      state: "succeeded",
      step: undefined,
      requestedAtMs: finishedAtMs,
      startedAtMs: finishedAtMs,
      deadlineAtMs: finishedAtMs,
      finishedAtMs,
      counts: EMPTY_RUN_COUNTS,
      errorCode: undefined,
      retryable: false,
    })) as RunRecord[];
    const start = vi.fn(async () => ({}) as RunRecord);
    const runner = { start } as unknown as SyncRunner;

    await new JobScheduler(storeReturning({ watch_a: quiet }), runner).tick();
    expect(start).not.toHaveBeenCalled();

    const steady = async () => new Set(["pull"]);
    await new JobScheduler(storeReturning({ watch_a: quiet }), runner, undefined, steady).tick();
    expect(start).toHaveBeenCalledOnce();
  });
});
