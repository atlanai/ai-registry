import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { LeaseBusyError, LeaseError } from "./errors.ts";
import { acquire as acquireLease, breakLease, type Lease, readLease, withLease } from "./lease.ts";
import { leaseKey } from "./location.ts";

interface Fault {
  suffix: string;
  code: string;
  times: number;
}

const faults = vi.hoisted(() => ({ list: [] as Fault[] }));

/** Throws the first fault still armed for `path`, as the call named `call` would. */
function fault(call: string, path: unknown): void {
  const found = faults.list.find((f) => f.times > 0 && String(path).endsWith(f.suffix));
  if (found === undefined) return;
  found.times -= 1;
  throw Object.assign(new Error(`${found.code}: ${call} '${String(path)}'`), { code: found.code });
}

// Mocked for this file alone, so a test can make removing a folder fail. Moving one aside fails
// alike, as a handle that blocks a delete on Windows blocks a rename too.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fault("rm", args[0]);
      return actual.rm(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fault("rename", args[0]);
      return actual.rename(...args);
    },
  };
});

/** Makes removing a path ending in `suffix` fail with `code`, `times` times. */
function failRm(suffix: string, code: string, times = Number.POSITIVE_INFINITY): void {
  faults.list.push({ suffix, code, times });
}

let home: string;
let env: NodeJS.ProcessEnv;
let held: Lease[];

async function acquire(...args: Parameters<typeof acquireLease>): Promise<Lease> {
  const lease = await acquireLease(...args);
  held.push(lease);
  return lease;
}

const scope = (lock: string) => ({ scope: "project" as const, lock });

/** Ages a lease past the 30s staleness window without waiting for it. */
async function ageLease(lock: string): Promise<void> {
  const meta = join(home, "leases", `${leaseKey({ lock })}.lease`, "meta.json");
  const past = new Date(Date.now() - 60_000);
  await utimes(meta, past, past);
}

/** Advance only after a poll is scheduled, so slow real I/O cannot consume the clock budget. */
async function rejection(run: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  let outcome: { kind: "fulfilled" } | { kind: "rejected"; reason: unknown } | undefined;
  const pending = run(controller.signal).then(
    () => {
      outcome = { kind: "fulfilled" };
    },
    (reason: unknown) => {
      outcome = { kind: "rejected", reason };
    },
  );
  const deadline = performance.now() + 5_000;
  while (outcome === undefined && performance.now() < deadline) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await new Promise((wake) => setImmediate(wake));
  }
  if (outcome === undefined) {
    controller.abort();
    // Finish an in-flight poll before teardown removes its fixture.
    const cleanupDeadline = performance.now() + 5_000;
    while (outcome === undefined && performance.now() < cleanupDeadline) {
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
      else await new Promise((wake) => setImmediate(wake));
    }
    throw new Error("Lease failure did not settle within the real I/O deadline");
  }
  await pending;
  if (outcome.kind === "fulfilled")
    throw new Error("Expected the lease attempt to reject, but it fulfilled");
  return outcome.reason;
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  env = { AIREG_HOME: home };
  held = [];
});

afterEach(async () => {
  vi.useRealTimers();
  faults.list = [];
  await Promise.all(held.map((lease) => lease.release()));
});

describe("releasing when a directory cannot be removed", () => {
  test("keeps the result when removing the coordination lock fails once", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    failRm(".coordination", "EPERM", 1);

    expect(await withLease(roots, { env }, async () => 7)).toBe(7);

    // A leftover lock is reclaimed by the next caller once it is stale.
    const coordination = join(home, "leases", ".coordination");
    const past = new Date(Date.now() - 10_000);
    await utimes(coordination, past, past);
    const next = await acquire(roots, { env });
    await next.release();
  });

  test("keeps the result when removing the coordination lock keeps failing", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    failRm(".coordination", "EPERM");

    expect(await withLease(roots, { env }, async () => 7)).toBe(7);
  });

  test("keeps the result when removing the lease keeps failing", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    failRm(".lease", "EPERM");

    expect(await withLease(roots, { env }, async () => 7)).toBe(7);
    // The leftover still names its holder, so it goes stale rather than vanishing.
    expect(await readLease(roots, env)).toBeDefined();
  });

  test("still surfaces a failure of the work done under the coordination lock", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });
    failRm(".coordination", "EPERM");
    failRm(".lease", "EACCES");

    await expect(breakLease(roots, held.id, env)).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("reclaiming a stale directory that cannot be removed", () => {
  test("keeps polling when reclaiming a stale coordination lock fails", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const coordination = join(home, "leases", ".coordination");
    await mkdir(coordination, { recursive: true });
    const past = new Date(Date.now() - 10_000);
    await utimes(coordination, past, past);
    failRm(".coordination", "EPERM", 1);

    const lease = await acquire(roots, { env });
    expect(await readLease(roots, env)).toMatchObject({ id: lease.id });
    await lease.release();
  });

  test("reports a stale lease it cannot reclaim as busy", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const lease = await acquire(roots, { env });
    failRm(".lease", "EPERM");
    // Stops the heartbeat, leaving the unremovable holder behind.
    await lease.release();
    await ageLease(roots.lock);

    await expect(acquire(roots, { env })).rejects.toThrow(LeaseBusyError);
  });
});

describe("waiting on a stale directory that cannot be removed", () => {
  test("stops waiting on a stale coordination lock that cannot be removed", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const coordination = join(home, "leases", ".coordination");
    await mkdir(coordination, { recursive: true });
    const past = new Date(Date.now() - 10_000);
    await utimes(coordination, past, past);
    failRm(".coordination", "EPERM");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const error = await rejection((signal) => acquire(roots, { env, signal }));

    expect(error).toBeInstanceOf(LeaseError);
    expect(error).toMatchObject({ code: "busy", reason: "lease_coordination_stuck" });
    expect((error as Error).message).toContain(coordination);
  });

  test("stops waiting on a stale lease that cannot be removed", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const lease = await acquire(roots, { env });
    failRm(".lease", "EPERM");
    // Stops the heartbeat, leaving the unremovable holder behind.
    await lease.release();
    await ageLease(roots.lock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const error = await rejection((signal) => acquire(roots, { env, wait: true, signal }));

    expect(error).toBeInstanceOf(LeaseError);
    expect(error).toMatchObject({ code: "busy", reason: "lease_stuck" });
    expect((error as Error).message).toContain(`${leaseKey(roots)}.lease`);
  });
});
