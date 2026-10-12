import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Job } from "#core/config/model.ts";
import type { StepContribution } from "#core/host/extend.ts";
import { createLogger } from "#core/log/index.ts";
import { ManifestError } from "#core/manifest.ts";
import { jobOfWork, type ScopeWork } from "#engine/work.ts";
import { memorySink } from "#test/kit/memory-sink.ts";
import { SqliteRunStore } from "./run-store.ts";
import { SyncRunner } from "./runner.ts";

const sync = vi.hoisted(() => ({
  waiting: [] as (() => void)[],
  calls: 0,
  /** Lets every run still syncing finish. */
  release() {
    for (const resolve of this.waiting.splice(0)) resolve();
  },
}));

/** What the account's registry resolves to, and which adapters registered which step kinds. */
const adapters = vi.hoisted(() => ({
  resolve: undefined as (() => Promise<unknown>) | undefined,
  own: undefined as unknown,
  contributed: undefined as unknown,
  byKind: {} as Record<string, unknown>,
}));

vi.mock("#accounts/service.ts", () => ({
  AccountService: class {
    resolve() {
      return adapters.resolve?.() ?? Promise.resolve({ adapter: {} });
    }
  },
}));
vi.mock("#core/host/load.ts", () => ({
  stepOn: () => adapters.own,
  stepContribution: async (kind: string) =>
    kind in adapters.byKind ? adapters.byKind[kind] : adapters.contributed,
}));

vi.mock("#core/config/repository.ts", () => ({
  readConfig: async () => ({ revision: 1, jobs: [], accounts: [] }),
}));
vi.mock("#engine/execute.ts", () => ({
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
  adapters.resolve = undefined;
  adapters.own = undefined;
  adapters.contributed = undefined;
  adapters.byKind = {};
});

afterEach(async () => {
  vi.useRealTimers();
  sync.release();
  await runner.stop();
  store.close();
});

describe("one-off sync runs", () => {
  it("joins the run already doing the same request rather than starting another", async () => {
    const first = oneOff();
    const second = oneOff();
    const a = await runner.start(first.id, "sync", "manual", { ephemeral: first.target });
    const b = await runner.start(second.id, "sync", "manual", { ephemeral: second.target });

    expect(b.id).toBe(a.id);
    await vi.waitFor(() => expect(sync.calls).toBe(1));
  });

  it("starts a separate run for a different scope, and anew once the first ends", async () => {
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
  // The mocked sync never looks at its signal, which is the case being guarded.
  it("is settled as timed out a grace period after its deadline, and frees its job", async () => {
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

  it("does not hold a stop open past the grace period", async () => {
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

describe("an adapter step whose account registry does not resolve", () => {
  const SUCCEEDED = {
    state: "succeeded",
    counts: { examined: 1, changed: 0, skipped: 0, attention: 0, failed: 0 },
  };
  const step = (run = vi.fn(async () => SUCCEEDED)) =>
    ({ kind: "mcp-scan", run }) as unknown as StepContribution & { run: typeof run };
  const target = (
    names = ["mcp"],
    kinds: string[] = [],
  ): { id: string; target: { job: Job; account: Account } } => {
    const job = {
      id: "job_adapter",
      account: account.id,
      schedule: { every: 900, enabled: false },
      steps: names.map((name, i) => ({
        name,
        kind: kinds[i] ?? "mcp-scan",
        needs: [],
        select: [],
        policy: "apply",
        extra: {},
      })),
    } as unknown as Job;
    return { id: job.id, target: { job, account } };
  };
  let sink: ReturnType<typeof memorySink>;
  const start = async (adapterRunner: SyncRunner, names?: string[], kinds?: string[]) => {
    const { id, target: t } = target(names, kinds);
    const run = await adapterRunner.start(id, "sync", "manual", { ephemeral: t });
    await vi.waitFor(() => expect(store.get(run.id)?.state).not.toBe("running"));
    return store.get(run.id);
  };
  const undeclared = new ManifestError('registry "shop" is not declared');

  let adapterRunner: SyncRunner;
  beforeEach(() => {
    sink = memorySink();
    const log = createLogger({ sink, level: "trace" });
    adapterRunner = new SyncRunner(store, () => {}, "0.0.0-test", log);
  });
  afterEach(() => adapterRunner.stop());

  it("runs the step through an installed adapter that registered the kind, and says why", async () => {
    adapters.resolve = () => Promise.reject(undeclared);
    const contributed = step();
    adapters.contributed = contributed;
    expect(await start(adapterRunner)).toMatchObject({ state: "succeeded" });
    expect(contributed.run).toHaveBeenCalledOnce();
    const warned = sink.records.filter((r) => r.severity_text === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.error?.message).toBe(undeclared.message);
  });

  it("still prefers the account's own adapter when the registry resolves", async () => {
    const own = step();
    const contributed = step();
    adapters.own = own;
    adapters.contributed = contributed;
    expect(await start(adapterRunner)).toMatchObject({ state: "succeeded" });
    expect(own.run).toHaveBeenCalledOnce();
    expect(contributed.run).not.toHaveBeenCalled();
    expect(sink.records.filter((r) => r.severity_text === "warn")).toEqual([]);
  });

  it("falls back to a contributed step when the account's adapter does not run the kind", async () => {
    const contributed = step();
    adapters.contributed = contributed;
    expect(await start(adapterRunner)).toMatchObject({ state: "succeeded" });
    expect(contributed.run).toHaveBeenCalledOnce();
  });

  it("fails with the resolve error, not 'no adapter', when nothing runs the kind", async () => {
    adapters.resolve = () => Promise.reject(undeclared);
    expect(await start(adapterRunner)).toMatchObject({ state: "failed" });
    const failure = sink.records.find((r) => r.body === "run failed");
    expect(failure?.error?.message).toBe(undeclared.message);
  });

  it("still fails with 'no adapter' when the registry resolves but nothing runs the kind", async () => {
    expect(await start(adapterRunner)).toMatchObject({ state: "failed" });
    const failure = sink.records.find((r) => r.body === "run failed");
    expect(failure?.error?.message).toContain('No installed adapter runs "mcp-scan" steps');
  });

  it("resolves the registry once per run and warns once, however many steps fall back", async () => {
    const resolve = vi.fn(() => Promise.reject(undeclared));
    adapters.resolve = resolve;
    const contributed = step();
    adapters.contributed = contributed;
    expect(await start(adapterRunner, ["scan", "report"])).toMatchObject({ state: "succeeded" });
    expect(contributed.run).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledOnce();
    expect(sink.records.filter((r) => r.severity_text === "warn")).toHaveLength(1);
  });

  it("fails with the resolve error after a fallen-back step, when a later step has no adapter", async () => {
    adapters.resolve = () => Promise.reject(undeclared);
    const contributed = step();
    adapters.byKind = { "mcp-scan": contributed, "mcp-report": undefined };
    const result = await start(adapterRunner, ["scan", "report"], ["mcp-scan", "mcp-report"]);
    expect(result).toMatchObject({ state: "failed" });
    expect(contributed.run).toHaveBeenCalledOnce();
    const failure = sink.records.find((r) => r.body === "run failed");
    expect(failure?.error?.message).toBe(undeclared.message);
  });

  it("names the run in its one fallback warning", async () => {
    adapters.resolve = () => Promise.reject(undeclared);
    adapters.contributed = step();
    const run = await start(adapterRunner);
    const warned = sink.records.filter((r) => r.severity_text === "warn");
    expect(warned[0]?.attributes).toMatchObject({ runId: run?.id, jobId: "job_adapter" });
  });
});
