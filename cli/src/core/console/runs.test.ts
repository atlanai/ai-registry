import { describe, expect, test } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { EMPTY_RUN_COUNTS, ITEM_EVENT, type RunEvent, type RunRecord } from "#core/run/model.ts";
import { carriedPaths, jobRows, newestFinished, upstreamFacts } from "./runs.ts";

function event(over: Partial<RunEvent>): RunEvent {
  return {
    id: 1,
    runId: "run_1",
    seq: 1,
    occurredAtMs: 0,
    eventType: ITEM_EVENT,
    step: "pull",
    artifact: undefined,
    kind: undefined,
    disposition: undefined,
    operation: undefined,
    outcome: undefined,
    errorCode: undefined,
    retryable: false,
    data: undefined,
    ...over,
  };
}

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: "run_1",
    jobId: "job_1",
    accountId: "acc_1",
    configRevision: 1,
    mode: "sync",
    trigger: "schedule",
    state: "succeeded",
    step: "pull",
    requestedAtMs: 1_000,
    startedAtMs: 1_000,
    deadlineAtMs: 9_000,
    finishedAtMs: 2_000,
    counts: EMPTY_RUN_COUNTS,
    errorCode: undefined,
    retryable: false,
    ...over,
  };
}

describe("newestFinished", () => {
  test("skips a run still going, which reports nothing examined", () => {
    const chosen = newestFinished(
      [
        run({ id: "old", requestedAtMs: 1, counts: { ...EMPTY_RUN_COUNTS, examined: 695 } }),
        run({ id: "live", requestedAtMs: 9, state: "running" }),
      ],
      "sync",
    );
    expect(chosen?.id).toBe("old");
  });

  test("counts a run the daemon abandoned as finished", () => {
    const chosen = newestFinished([run({ id: "gone", state: "abandoned" })], "sync");
    expect(chosen?.id).toBe("gone");
  });

  test("ignores another mode's runs", () => {
    expect(newestFinished([run({ mode: "pull" })], "sync")).toBeUndefined();
  });
});

describe("upstreamFacts", () => {
  test("reads the adapter's own reason, not only the code", () => {
    const facts = upstreamFacts([
      event({
        artifact: "eng/explain",
        errorCode: "adapter_not_found",
        data: { detail: "HTTP 404" },
      }),
      event({ artifact: "eng/flow", errorCode: "adapter_not_found" }),
    ]);
    expect(facts.failed.get("eng/explain")).toBe("HTTP 404");
    expect(facts.failed.get("eng/flow")).toBe("adapter_not_found");
  });

  test("strips terminal escapes from the adapter's reason", () => {
    const facts = upstreamFacts([
      event({
        artifact: "eng/explain",
        errorCode: "adapter_invalid",
        data: { detail: "bad\u001b[2Jname" },
      }),
    ]);
    expect(facts.failed.get("eng/explain")).toBe("badname");
  });

  test("treats a publish that settled for review as pending, not as changed", () => {
    const facts = upstreamFacts([
      event({
        artifact: "mine/demo",
        disposition: "publish",
        operation: "publish",
        outcome: "attention",
      }),
      event({
        artifact: "mine/other",
        disposition: "publish",
        operation: "publish",
        outcome: "changed",
      }),
      event({
        artifact: "mine/edited",
        disposition: "publish",
        operation: "report",
        outcome: "attention",
      }),
    ]);
    // `mine/edited` was only reported, never sent, so nothing upstream waits on it.
    expect([...facts.pending]).toEqual(["mine/demo"]);
  });
});

describe("carriedPaths", () => {
  test("maps each folder a job settled to that job, with the held reason", () => {
    const carried = carriedPaths([
      {
        job: "import-local",
        jobId: "job_import",
        settledAtMs: 1000,
        events: [
          event({
            artifact: "a",
            outcome: "changed",
            data: { paths: ["/s/a", "/t/a"], state: "live" },
          }),
          event({
            artifact: "b",
            outcome: "attention",
            data: { paths: ["/s/b"], state: "blocked", detail: "held" },
          }),
        ],
      },
    ]);
    expect([...carried.keys()]).toEqual(["/s/a", "/t/a", "/s/b"]);
    expect(carried.get("/s/b")).toEqual({
      job: "import-local",
      jobId: "job_import",
      settledAtMs: 1000,
      outcome: "attention",
      detail: "held",
    });
  });

  test("ignores data it cannot read, and items the job refused", () => {
    const carried = carriedPaths([
      {
        job: "import-local",
        jobId: "job_import",
        settledAtMs: 1000,
        events: [
          event({ artifact: "a", outcome: "changed", data: undefined }),
          event({ artifact: "b", outcome: "changed", data: { paths: "/s/b" } }),
          event({ artifact: "c", outcome: "changed", data: { paths: [7, null, "/s/c"] } }),
          event({
            artifact: "d",
            outcome: "failed",
            errorCode: "refused",
            data: { paths: ["/s/d"] },
          }),
          event({ eventType: "step.started", data: { paths: ["/s/e"] } }),
        ],
      },
    ]);
    expect([...carried.keys()]).toEqual(["/s/c"]);
  });
});

describe("jobRows", () => {
  test("describes a job by the steps it runs, in order", () => {
    const step = (name: string, kind: string, needs: string[] = []) => ({
      name,
      kind,
      needs,
      select: [],
      policy: "on" as const,
      extra: {},
    });
    const config = {
      ...emptyRegistryConfig(),
      jobs: [
        {
          id: "job_skills",
          account: "acc_1",
          schedule: { every: 900, enabled: true },
          steps: [{ ...step("pull", "pull"), root: "/home" }],
        },
        {
          id: "job_probe",
          account: "acc_1",
          schedule: { every: 900, enabled: false },
          steps: [step("probe", "probe")],
        },
      ],
    };
    const rows = jobRows(config, [run({ jobId: "job_skills", requestedAtMs: 5_000 })]);
    expect(rows[0]?.summary).toBe("pull:pull");
    expect(rows[0]?.nextRunAtMs).toBe(5_000 + 900_000);
    expect(rows[1]?.summary).toBe("probe:probe");
    // A disabled job is never scheduled, so it has no next run to show.
    expect(rows[1]?.nextRunAtMs).toBeUndefined();
  });
});
