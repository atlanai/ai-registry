import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Account } from "#core/config/model.ts";
import { jobOfWork, type ScopeWork } from "#engine/sync/work.ts";
import { SyncRunner } from "./runner.ts";
import { SqliteRunStore } from "./store.ts";

const sync = vi.hoisted(() => ({
  waiting: [] as (() => void)[],
  calls: 0,
  /** Lets every run still syncing finish. */
  release() {
    for (const resolve of this.waiting.splice(0)) resolve();
  },
}));

vi.mock("#core/config/repository.ts", () => ({
  readConfig: async () => ({ revision: 1, jobs: [], accounts: [] }),
}));
vi.mock("#engine/sync/execute.ts", () => ({
  executeSync: async () => {
    sync.calls += 1;
    await new Promise<void>((resolve) => sync.waiting.push(resolve));
    return {
      counts: { examined: 0, changed: 0, skipped: 0, attention: 0, failed: 0 },
      state: "succeeded",
    };
  },
}));

const account: Account = { id: "acc_anonymous_shop", registry: "shop" };

/** What `sync.start` builds for each request: the same work under a fresh id. */
function oneOff(root = "/project") {
  const work: ScopeWork = {
    id: `job_foreground_${Math.random()}`,
    root,
    scope: "project",
    account: account.id,
    policy: { pull: "on", publish: "on", delete: "on" },
    steps: [],
  };
  return { id: work.id, target: { job: jobOfWork(work), account } };
}

let store: SqliteRunStore;
let runner: SyncRunner;

beforeEach(async () => {
  store = await SqliteRunStore.open(":memory:");
  runner = new SyncRunner(store, () => {});
  sync.calls = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  sync.release();
  await runner.stop();
  store.close();
});

describe("one-off sync runs", () => {
  test("joins the run already doing the same request rather than starting another", async () => {
    const first = oneOff();
    const second = oneOff();
    const a = await runner.start(first.id, "sync", "manual", { ephemeral: first.target });
    const b = await runner.start(second.id, "sync", "manual", { ephemeral: second.target });

    expect(b.id).toBe(a.id);
    await vi.waitFor(() => expect(sync.calls).toBe(1));
  });

  test("starts a separate run for a different scope, and anew once the first ends", async () => {
    const first = oneOff();
    const a = await runner.start(first.id, "sync", "manual", { ephemeral: first.target });
    const elsewhere = oneOff("/other");
    const b = await runner.start(elsewhere.id, "sync", "manual", { ephemeral: elsewhere.target });
    expect(b.id).not.toBe(a.id);

    await vi.waitFor(() => expect(sync.calls).toBe(2));
    sync.release();
    await vi.waitFor(() => expect(store.get(a.id)?.state).toBe("succeeded"));

    const again = oneOff();
    const c = await runner.start(again.id, "sync", "manual", { ephemeral: again.target });
    expect(c.id).not.toBe(a.id);
  });
});

describe("a run whose work ignores its abort", () => {
  // The mocked sync never looks at its signal.
  test("is settled as timed out a grace period after its deadline, and frees its job", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const first = oneOff();
    const run = await runner.start(first.id, "sync", "manual", { ephemeral: first.target });
    await vi.waitFor(() => expect(sync.calls).toBe(1));

    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect(store.get(run.id)?.state).toBe("running");
    await vi.advanceTimersByTimeAsync(30 * 1_000);
    expect(store.get(run.id)).toMatchObject({ state: "timed_out", errorCode: "run_timed_out" });

    const again = oneOff();
    const next = await runner.start(again.id, "sync", "manual", { ephemeral: again.target });
    expect(next.id).not.toBe(run.id);
  });

  test("does not hold a stop open past the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = oneOff();
    await runner.start(first.id, "sync", "manual", { ephemeral: first.target });
    await vi.waitFor(() => expect(sync.calls).toBe(1));

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(stopped).toBe(true);
  });
});
