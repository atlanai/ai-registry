import { describe, expect, test } from "vitest";
import { AdapterError } from "#adapter/index.ts";
import { LeaseError } from "#core/lease/errors.ts";
import { EMPTY_RUN_COUNTS, type RunRecord } from "#core/run/model.ts";
import { RunScopeError } from "#engine/sync/narrow.ts";
import { classifyFailure, dueAt } from "./failure.ts";

const WATCH = { schedule: { every: 60, enabled: true } } as Parameters<typeof dueAt>[0];

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run",
    jobId: "job_1",
    accountId: "acc_1",
    configRevision: 1,
    mode: "sync",
    trigger: "schedule",
    state: "succeeded",
    step: "pull",
    requestedAtMs: 0,
    startedAtMs: 0,
    deadlineAtMs: 0,
    finishedAtMs: 0,
    counts: EMPTY_RUN_COUNTS,
    errorCode: undefined,
    retryable: false,
    ...over,
  };
}

/** `count` earlier runs beside the latest, all reaching the same conclusion. */
function repeatedHistory(count: number): RunRecord[] {
  return Array.from({ length: count + 1 }, (_, index) => run({ id: `run_${index}` }));
}

describe("dueAt", () => {
  test("waits the plain interval the first time and doubles per repeat", () => {
    expect(dueAt(WATCH, repeatedHistory(0))).toBe(60_000);
    expect(dueAt(WATCH, repeatedHistory(1))).toBe(120_000);
    expect(dueAt(WATCH, repeatedHistory(4))).toBe(960_000);
  });

  test("never leaves a job alone past the ceiling", () => {
    expect(dueAt(WATCH, repeatedHistory(40))).toBe(30 * 60_000);
  });

  test("never schedules a job sooner than its own interval", () => {
    const daily = { schedule: { every: 24 * 60 * 60, enabled: true } } as typeof WATCH;
    expect(dueAt(daily, repeatedHistory(0))).toBe(24 * 60 * 60_000);
    expect(dueAt(daily, repeatedHistory(5))).toBe(24 * 60 * 60_000);
  });

  test("keeps a steady job on its interval however often nothing changes", () => {
    expect(dueAt(WATCH, repeatedHistory(0), true)).toBe(60_000);
    expect(dueAt(WATCH, repeatedHistory(6), true)).toBe(60_000);
  });

  test("still backs off a steady job that keeps failing", () => {
    const failing = [
      run({ id: "run_1", state: "failed", errorCode: "sync_failed" }),
      run({ id: "run_0", state: "failed", errorCode: "sync_failed" }),
    ];
    expect(dueAt(WATCH, failing, true)).toBe(120_000);
  });

  test("stops the repeat count at the first run with a different outcome", () => {
    const recent = [
      run({ id: "run_2", counts: { ...EMPTY_RUN_COUNTS, attention: 1 } }),
      run({ id: "run_1", counts: { ...EMPTY_RUN_COUNTS, attention: 1 } }),
      run({ id: "run_0", counts: { ...EMPTY_RUN_COUNTS, attention: 2 } }),
    ];
    expect(dueAt(WATCH, recent)).toBe(120_000);
  });

  test("backs off consecutive outright failures, ignoring interruptions between them", () => {
    const recent = [
      run({ id: "run_2", state: "failed", finishedAtMs: 300 }),
      run({ id: "run_1", state: "canceled" }),
      run({ id: "run_0", state: "failed" }),
    ];
    // A streak of two: the canceled run in between is skipped, not counted,
    // and does not reset the streak either.
    expect(dueAt(WATCH, recent)).toBe(300 + 60_000 * 2);
  });

  test("keeps the interval when the clock stepped back past the last run", () => {
    const now = 1_000_000;
    const ahead = [run({ finishedAtMs: now + 2 * 60 * 60_000 })];
    expect(dueAt(WATCH, ahead, true, now)).toBe(now + 60_000);
  });

  test("runs immediately once a job was abandoned, and after one interval once canceled", () => {
    expect(dueAt(WATCH, [run({ state: "abandoned", finishedAtMs: 500 })])).toBe(0);
    expect(dueAt(WATCH, [run({ state: "canceled", finishedAtMs: 500 })])).toBe(60_500);
  });
});

describe("failure classification", () => {
  test("keeps an adapter's retry-later answer retryable, partial once anything landed", () => {
    const later = new AdapterError("acme", "unavailable", "rate limited", {
      retryAfterMs: 30_000,
    });
    expect(classifyFailure(later, undefined, 0)).toMatchObject({
      state: "failed",
      errorCode: "adapter_unavailable",
      retryable: true,
      interrupted: false,
    });
    expect(classifyFailure(later, undefined, 2).state).toBe("partial");
  });

  test("classifies an adapter throw from a packed module the CLI did not construct", () => {
    const packed = new Error("rate limited");
    packed.name = "AdapterError";
    Object.assign(packed, { adapter: "acme", failure: "unavailable" });
    expect(classifyFailure(packed, undefined, 0)).toMatchObject({
      state: "failed",
      errorCode: "adapter_unavailable",
      retryable: true,
    });
  });

  test("names a lease another writer took over, and retries from what it wrote", () => {
    const lost = new LeaseError("Another process took over the lease", { reason: "lease_lost" });
    expect(classifyFailure(lost, undefined, 0)).toEqual({
      state: "failed",
      errorCode: "lease_lost",
      retryable: true,
      interrupted: false,
    });
    expect(classifyFailure(lost, undefined, 1).state).toBe("partial");
  });

  test("names a ref that reached nothing, and does not offer to retry it", () => {
    // Generic `sync_failed` would read as an outage; the address was just wrong.
    expect(classifyFailure(new RunScopeError(["shop/sales/skill/absent"]), undefined, 0)).toEqual({
      state: "failed",
      errorCode: "run_scope_unmatched",
      retryable: false,
      interrupted: false,
    });
  });
});
