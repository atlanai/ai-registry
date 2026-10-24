import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { Account } from "#core/config/model.ts";
import type { SyncItem } from "#core/sync/model.ts";
import { test } from "#test/kit/fixtures.ts";
import { executeSync } from "./execute.ts";
import type { Loaded } from "./pipeline.ts";
import type { Scan } from "./scan.ts";
import { RunScopeError } from "./scope.ts";
import type { ScopeWork } from "./work.ts";

const REGISTRY = "shop";
const ENDPOINT = "https://shop.test/";

const loaded = {
  // Enough of a scope for the import step to find an empty list rather than
  // a path built from undefined.
  roots: {
    scope: "project",
    cwd: tmpdir(),
    artifacts: join(tmpdir(), "aireg-execute-test-artifacts"),
    base: tmpdir(),
  },
  manifest: {
    registries: { [REGISTRY]: { location: ENDPOINT, adapter: "acme", config: {} } },
  },
  lock: { registries: {}, artifacts: {} },
  harnesses: {},
} as unknown as Loaded;

const job: ScopeWork = {
  id: "job-1",
  root: "/project",
  scope: "project",
  account: "account-1",
  policy: { pull: "on", publish: "on", delete: "on" },
  steps: [],
};

const account: Account = {
  id: "account-1",
  registry: REGISTRY,
};

function item(name: string, disposition: SyncItem["disposition"]): SyncItem {
  return {
    name,
    kind: "skill",
    source: REGISTRY,
    path: name,
    disposition,
    digests: {},
    detail: undefined,
  } as unknown as SyncItem;
}

function scanOf(items: SyncItem[], locked: readonly string[] = []): Scan {
  return {
    items,
    local: [],
    undeclared: [],
    publisher: new Map(),
    pinned: {
      registries: {},
      artifacts: Object.fromEntries(locked.map((name) => [name, { name }])),
    },
    acquired: [],
  } as unknown as Scan;
}

const scan = vi.hoisted(() => vi.fn());
const mutateRemote = vi.hoisted(() => vi.fn());
const applyLocal = vi.hoisted(() => vi.fn());
const partialMutation = vi.hoisted(() => vi.fn());

// This suite is about classification, not locking.
vi.mock("#core/lease.ts", () => ({
  withLease: (_roots: unknown, _options: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("./scan.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scan.ts")>()),
  scan,
}));
vi.mock("./remote.ts", () => ({ mutateRemote, partialMutation }));
vi.mock("./local.ts", () => ({ applyLocal }));
const load = vi.hoisted(() => vi.fn());
vi.mock("./pipeline.ts", () => ({ load }));
// A token named after the place it was released for, so a test can see where each one went.
vi.mock("#accounts/credentials.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#accounts/credentials.ts")>()),
  credentialsForManifest: async (registries: Record<string, { location: string }>) =>
    Object.fromEntries(
      Object.entries(registries).map(([alias, { location }]) => [
        alias,
        { type: "bearer", accessToken: `released for ${location}` },
      ]),
    ),
}));

const hooks = { event: () => {}, item: () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  load.mockResolvedValue(loaded);
  applyLocal.mockResolvedValue({ changed: 0, notices: [] });
});

function namesPassedToApply(): string[] {
  const call = applyLocal.mock.calls.at(-1);
  if (call === undefined) throw new Error("applyLocal was not called");
  return [...(call[3] as ReadonlySet<string>)].sort();
}

test("applies what the first scan classified when nothing was published", async () => {
  // `beta` is already locked, so agreeing with the registry leaves nothing to do.
  scan.mockResolvedValue(scanOf([item("alpha", "pull"), item("beta", "synced")], ["beta"]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  // Once to classify, once again inside the lease: another run may have written
  // the lock while this one was deciding what to do.
  expect(scan).toHaveBeenCalledTimes(2);
  expect(namesPassedToApply()).toEqual(["alpha"]);
});

test("reports what the apply did to a person's files as a run warning", async () => {
  scan.mockResolvedValue(scanOf([item("alpha", "pull")]));
  mutateRemote.mockResolvedValue({ published: new Set<string>(), archived: new Set<string>() });
  const moved = { message: "Moved your folder .claude/skills/alpha to .registry/backups/alpha." };
  applyLocal.mockResolvedValueOnce({ changed: 1, notices: [moved] });
  const event = vi.fn();

  await executeSync(job, account, "sync", undefined, new AbortController().signal, {
    ...hooks,
    event,
  });

  expect(event).toHaveBeenCalledWith("run.warning", "applying", undefined, moved);
});

test("closes every source each scan opened once the run ends, even when it fails", async () => {
  const opened: ReturnType<typeof vi.fn>[] = [];
  const scanWithSource = (items: SyncItem[]) => {
    const close = vi.fn(async () => {});
    opened.push(close);
    return { ...scanOf(items), acquired: [{ alias: REGISTRY, close }] } as unknown as Scan;
  };
  scan.mockImplementation(async () => scanWithSource([item("alpha", "pull")]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);
  expect(opened).toHaveLength(2);
  for (const close of opened) expect(close).toHaveBeenCalledTimes(1);

  opened.length = 0;
  applyLocal.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    executeSync(job, account, "sync", undefined, new AbortController().signal, hooks),
  ).rejects.toThrow("disk full");
  expect(opened).toHaveLength(2);
  for (const close of opened) expect(close).toHaveBeenCalledTimes(1);
});

test("rebases on the lock as it is inside the lease, not as it was outside", async () => {
  // A concurrent run settled `alpha` while this one was still classifying.
  scan
    .mockResolvedValueOnce(scanOf([item("alpha", "pull"), item("beta", "pull")]))
    .mockResolvedValue(scanOf([item("alpha", "synced"), item("beta", "pull")], ["alpha"]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  // `alpha` is settled and recorded, so only `beta` is still this run's to write.
  expect(namesPassedToApply()).toEqual(["beta"]);
});

test("records an artifact that agrees with the registry but is locked nowhere", async () => {
  // What an adopt-then-publish leaves behind: the bytes match, and without this
  // the lock never learns the artifact exists, so nothing can be compared later.
  scan.mockResolvedValue(scanOf([item("beta", "synced")]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  expect(namesPassedToApply()).toEqual(["beta"]);
});

test("records a newer upstream identity when its bytes already match the copy", async () => {
  // A job that published the copy: the registry now serves exactly those bytes
  // under a new version, and the lock still names the one before it.
  const found = scanOf([item("beta", "synced")]);
  found.pinned.artifacts.beta = { name: "beta", content: "sha256:old" } as never;
  found.acquired.push({
    alias: REGISTRY,
    placements: new Map([["beta", { id: "beta", name: "beta", contentId: "sha256:new" }]]),
    close: async () => {},
  } as never);
  scan.mockResolvedValue(found);
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  expect(namesPassedToApply()).toEqual(["beta"]);
});

test("applies the re-scan's classification, not the stale one, after a publish", async () => {
  scan
    .mockResolvedValueOnce(
      scanOf([item("alpha", "publish"), item("beta", "synced")], ["alpha", "beta"]),
    )
    .mockResolvedValueOnce(
      scanOf([item("alpha", "publish"), item("beta", "synced")], ["alpha", "beta"]),
    )
    .mockResolvedValue(scanOf([item("alpha", "synced"), item("beta", "pull")], ["alpha"]));
  mutateRemote.mockResolvedValue({
    published: new Set(["alpha"]),
    archived: new Set<string>(),
  });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  // Classify, rebase inside the lease, then re-scan because the publish landed.
  expect(scan).toHaveBeenCalledTimes(3);
  // "alpha" was published; "beta" comes only from the scan taken after it.
  expect(namesPassedToApply()).toEqual(["alpha", "beta"]);
});

test("applies classified pulls when a publish is refused", async () => {
  scan.mockResolvedValue({
    ...scanOf([item("alpha", "pull")]),
    local: [{ name: "e2e-local", kind: "skill", from: "/tmp/e2e-local" }],
  });
  mutateRemote.mockRejectedValue(new Error("HTTP 422"));

  await expect(
    executeSync(job, account, "sync", undefined, new AbortController().signal, hooks),
  ).rejects.toThrow("HTTP 422");

  expect(namesPassedToApply()).toEqual(["alpha"]);
});

test("re-scans when an archive landed and the publish after it failed", async () => {
  scan
    .mockResolvedValueOnce(scanOf([item("alpha", "publish"), item("beta", "synced")], ["alpha"]))
    .mockResolvedValueOnce(scanOf([item("alpha", "publish"), item("beta", "synced")], ["alpha"]))
    .mockResolvedValue(scanOf([item("beta", "pull")]));
  const refused = new Error("HTTP 422");
  mutateRemote.mockRejectedValue(refused);
  partialMutation.mockImplementation((error: unknown) =>
    error === refused ? { published: new Set<string>(), archived: new Set(["alpha"]) } : undefined,
  );

  await expect(
    executeSync(job, account, "sync", undefined, new AbortController().signal, hooks),
  ).rejects.toThrow("HTTP 422");

  // Classify, rebase inside the lease, then re-scan because the archive landed.
  expect(scan).toHaveBeenCalledTimes(3);
  // "beta" comes only from the scan taken after the archive changed the remote.
  expect(namesPassedToApply()).toEqual(["beta"]);
});

test("carries the adapter's refusal detail onto the item event, and no data otherwise", async () => {
  const unavailable = {
    ...item("alpha", "unavailable"),
    detail: "alpha is not served by this registry",
    failure: { code: "adapter_not_found", retryable: false },
  } as unknown as SyncItem;
  scan.mockResolvedValue(scanOf([unavailable, item("beta", "pull")]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });
  partialMutation.mockReturnValue(undefined);

  const seen: Array<{ artifact: string; settled: unknown; data: unknown }> = [];
  const capturing = {
    ...hooks,
    item: (artifact: string, _phase: string, settled: unknown, data?: unknown) => {
      seen.push({ artifact, settled, data });
    },
  };

  await executeSync(job, account, "sync", undefined, new AbortController().signal, capturing);

  const alpha = seen.find((entry) => entry.artifact === "alpha");
  expect(alpha?.data).toEqual({ detail: "alpha is not served by this registry" });
  expect(alpha?.settled).toMatchObject({ outcome: "failed", errorCode: "adapter_not_found" });
  const beta = seen.filter((entry) => entry.artifact === "beta");
  expect(beta).not.toEqual([]);
  expect(beta.every((entry) => entry.data === undefined)).toBe(true);
});

test("a publish the catalog has not listed yet stays changed, not attention", async () => {
  scan
    .mockResolvedValueOnce(scanOf([item("alpha", "publish")], ["alpha"]))
    .mockResolvedValueOnce(scanOf([item("alpha", "publish")], ["alpha"]))
    .mockResolvedValue(scanOf([]));
  mutateRemote.mockResolvedValue({
    published: new Set(["alpha"]),
    archived: new Set<string>(),
  });

  const result = await executeSync(
    job,
    account,
    "sync",
    undefined,
    new AbortController().signal,
    hooks,
  );

  expect(result.state).toBe("succeeded");
  expect(result.counts.attention).toBe(0);
  expect(namesPassedToApply()).toEqual(["alpha"]);
});

test("refuses a ref that reaches nothing instead of reporting an empty success", async () => {
  scan.mockResolvedValue(scanOf([item("alpha", "pull")]));

  // The address grammar `manifest.yml` uses, for an artifact that is not there.
  await expect(
    executeSync(
      job,
      account,
      "sync",
      [`${REGISTRY}/sales/skill/absent`],
      new AbortController().signal,
      hooks,
    ),
  ).rejects.toThrow(RunScopeError);

  // Nothing was classified, so nothing was written.
  expect(applyLocal).not.toHaveBeenCalled();
});

test("narrows a run by the address grammar, not only by the catalog name", async () => {
  scan.mockResolvedValue(scanOf([item("sales/alpha", "pull"), item("sales/beta", "pull")]));
  mutateRemote.mockResolvedValue({
    published: new Set<string>(),
    archived: new Set<string>(),
  });

  await executeSync(
    job,
    account,
    "sync",
    [`${REGISTRY}/sales/skill/alpha`],
    new AbortController().signal,
    hooks,
  );

  expect(namesPassedToApply()).toEqual(["sales/alpha"]);
});

describe("a folder the registry already publishes", () => {
  let root: string;
  const { artifacts, cwd } = loaded.roots;

  test.beforeEach(async ({ tmp }) => {
    root = tmp;
    // Claiming moves only copies inside the scope, so the project is where the copies sit.
    Object.assign(loaded.roots, { cwd: root, artifacts: join(root, ".registry", "artifacts") });
    mutateRemote.mockResolvedValue({
      published: new Set<string>(),
      archived: new Set<string>(),
    });
  });
  afterEach(async () => {
    Object.assign(loaded.roots, { cwd, artifacts });
  });

  async function folder(path: string, body: string): Promise<string> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), body);
    return path;
  }

  async function scanWithCopy(body: string): Promise<{ scan: Scan; copy: string }> {
    const served = await folder(join(root, "served"), "same\n");
    const copy = await folder(join(root, ".claude", "skills", "hello"), body);
    const found = scanOf([item("ws/hello", "synced")], ["ws/hello"]);
    found.undeclared.push({
      name: "hello",
      kind: "skill",
      from: copy,
      target: "claude",
      suggestedPath: "skills/hello",
      description: undefined,
      elsewhere: [],
    });
    (found as { acquired: unknown }).acquired = [
      {
        alias: REGISTRY,
        catalog: { entries: [{ name: "hello", kind: "skill", path: "ws/hello" }] },
        placements: new Map(),
        content: async () => ({ root: served }),
        close: async () => {},
      },
    ];
    return { scan: found, copy };
  }

  const claiming = { ...job, policy: { ...job.policy, claim: "on" as const } };

  test("leaves a person's copy where it is unless claiming is asked for", async () => {
    const { scan: found, copy } = await scanWithCopy("same\n");
    scan.mockResolvedValue(found);
    const settled: unknown[] = [];
    await executeSync(job, account, "sync", undefined, new AbortController().signal, {
      ...hooks,
      item: (name: string, _phase: string, outcome: unknown) => settled.push([name, outcome]),
    });
    await expect(stat(copy)).resolves.toBeDefined();
    await expect(stat(join(root, ".registry", "backups"))).rejects.toThrow();
    expect(settled).not.toContainEqual(["hello", expect.anything()]);
  });

  test("moves an identical copy aside and links the registry's in its place", async () => {
    const { scan: found, copy } = await scanWithCopy("same\n");
    scan.mockResolvedValue(found);
    await executeSync(claiming, account, "sync", undefined, new AbortController().signal, hooks);
    await expect(stat(copy)).rejects.toThrow();
    const stamps = await readdir(join(root, ".registry", "backups"));
    expect(stamps).toHaveLength(1);
    await expect(
      stat(join(root, ".registry", "backups", stamps[0] ?? "", "claude", "skills", "hello")),
    ).resolves.toBeDefined();
    expect(namesPassedToApply()).toEqual(["ws/hello"]);
  });

  test("holds a changed copy for a person and leaves it where it is", async () => {
    const { scan: found, copy } = await scanWithCopy("edited\n");
    scan.mockResolvedValue(found);
    const settled: unknown[] = [];
    await executeSync(claiming, account, "sync", undefined, new AbortController().signal, {
      ...hooks,
      item: (name: string, _phase: string, outcome: unknown) => settled.push([name, outcome]),
    });
    await expect(stat(copy)).resolves.toBeDefined();
    expect(settled).toContainEqual([
      "hello",
      expect.objectContaining({ outcome: "attention", disposition: "conflict" }),
    ]);
  });

  test("moves nothing on a publish-only run, which pulls nothing into its place", async () => {
    const { scan: found, copy } = await scanWithCopy("same\n");
    scan.mockResolvedValue(found);
    await executeSync(claiming, account, "publish", undefined, new AbortController().signal, hooks);
    await expect(stat(copy)).resolves.toBeDefined();
  });

  test("moves nothing when the job only reports pulls", async () => {
    const { scan: found, copy } = await scanWithCopy("same\n");
    scan.mockResolvedValue(found);
    await executeSync(
      { ...claiming, policy: { ...claiming.policy, pull: "report" } },
      account,
      "sync",
      undefined,
      new AbortController().signal,
      hooks,
    );
    await expect(stat(copy)).resolves.toBeDefined();
  });
});

const ELSEWHERE = "https://elsewhere.test/";

/** The same scope, with its manifest now declaring the registry at another place. */
function moved(): Loaded {
  const registries = { [REGISTRY]: { location: ELSEWHERE, adapter: "acme", config: {} } };
  return { ...loaded, manifest: { registries } } as unknown as Loaded;
}

test("releases the token again for where the registry is declared after a reload", async () => {
  load.mockResolvedValueOnce(loaded).mockResolvedValue(moved());
  scan.mockResolvedValue(scanOf([item("alpha", "pull")]));
  mutateRemote.mockResolvedValue({ published: new Set<string>(), archived: new Set<string>() });

  await executeSync(job, account, "sync", undefined, new AbortController().signal, hooks);

  const sent = scan.mock.calls.map(([scanned, , options]) => ({
    at: (scanned as Loaded).manifest.registries[REGISTRY]?.location,
    token: options.credentials?.[REGISTRY]?.accessToken,
  }));
  expect(sent).toEqual([
    { at: ENDPOINT, token: `released for ${ENDPOINT}` },
    { at: ELSEWHERE, token: `released for ${ELSEWHERE}` },
  ]);
  expect(mutateRemote.mock.calls[0]?.[2]).toMatchObject({ location: ELSEWHERE });
});

test("stops when the reload no longer declares the registry, sending nothing", async () => {
  const dropped = { ...loaded, manifest: { registries: {} } } as unknown as Loaded;
  load.mockResolvedValueOnce(loaded).mockResolvedValue(dropped);
  scan.mockResolvedValue(scanOf([item("alpha", "pull")]));

  await expect(
    executeSync(job, account, "sync", undefined, new AbortController().signal, hooks),
  ).rejects.toThrow(`No registry named "${REGISTRY}"`);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(mutateRemote).not.toHaveBeenCalled();
});
