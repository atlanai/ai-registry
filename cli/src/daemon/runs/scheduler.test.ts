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
    defaults: {},
    adapters: {},
    accounts: [{ id: "acc_demo", registry: "personal" }],
    jobs,
    hooks: [],
  };
}

/** Only the one member the scheduler actually reads. */
function storeReturning(runs: Record<string, RunRecord[]>): RunStore {
  return {
    list: ({ jobId }: { jobId?: string }) => (jobId === undefined ? [] : (runs[jobId] ?? [])),
    forgetJobs: () => 0,
  } as unknown as RunStore;
}

/** One tick, awaited to its end: what start() fires at once and then every second. */
function tickOnce(scheduler: JobScheduler): Promise<void> {
  return (scheduler as unknown as { tick(): Promise<void> }).tick();
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

    await tickOnce(new JobScheduler(storeReturning({}), { start } as unknown as SyncRunner));

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

    await tickOnce(new JobScheduler(storeReturning({}), runner));

    expect(started).toEqual(["watch_b"]);
  });

  test("backs a failing job off instead of retrying it every tick", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => {
      throw new Error("Job account not found");
    });
    const scheduler = new JobScheduler(storeReturning({}), { start } as unknown as SyncRunner);

    // Without a deferral each tick retries, which is the 1 Hz hot loop this guards against.
    await tickOnce(scheduler);
    await tickOnce(scheduler);

    expect(start.mock.calls.length).toBe(1);
  });

  test("skips a job whose next run is not yet due", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    // A run that just settled leaves the job's own interval still ahead of it.
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

    await tickOnce(new JobScheduler(store, { start } as unknown as SyncRunner));

    expect(start).not.toHaveBeenCalled();
  });

  test("skips a job whose run is still active", async ({ home }) => {
    await writeConfig(config([job("watch_a", home.aireg)]), 0);
    const start = vi.fn(async () => ({}) as RunRecord);
    const store = storeReturning({
      watch_a: [{ id: "run_1", state: "running" } as RunRecord],
    });

    await tickOnce(new JobScheduler(store, { start } as unknown as SyncRunner));

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

    await tickOnce(new JobScheduler(storeReturning({ watch_a: quiet }), runner));
    expect(start).not.toHaveBeenCalled();

    const steady = async () => new Set(["pull"]);
    await tickOnce(new JobScheduler(storeReturning({ watch_a: quiet }), runner, undefined, steady));
    expect(start).toHaveBeenCalledOnce();
  });
});
