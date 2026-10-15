import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { writeAtomic } from "#core/fs/atomic.ts";
import { test } from "#test/kit/fixtures.ts";
import { expectMode } from "#test/kit/mode.ts";
import {
  acquire,
  breakLease,
  type Lease,
  LeaseBusyError,
  LeaseError,
  leaseKey,
  readLease,
  withLease,
} from "./lease.ts";

let home: string;
let env: NodeJS.ProcessEnv;

const scope = (lock: string) => ({ scope: "project" as const, lock });

function leaseMeta(lock: string): string {
  return join(home, "leases", `${leaseKey({ lock })}.lease`, "meta.json");
}

/** Ages a lease past the 30s staleness window without waiting for it. */
async function age(lock: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(leaseMeta(lock), when, when);
}

/** Rewrites a lease as another process left it: that holder, and a stale heartbeat. */
async function heldBy(lock: string, holder: { pid: number; host?: string }): Promise<void> {
  const meta = leaseMeta(lock);
  await mkdir(dirname(meta), { recursive: true });
  const current = await readFile(meta, "utf8").then(JSON.parse, () => ({ id: "left-behind" }));
  await writeFile(meta, JSON.stringify({ ...current, host: hostname(), ...holder }));
  await age(lock, 60_000);
}

let children: ChildProcess[];

/** A process that is still running, as a paused command would be. */
function running(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid as number;
}

async function exited(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid as number;
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  env = { AIREG_HOME: home };
  children = [];
});

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
});

describe("acquire", () => {
  test("grants the scope to one holder and refuses a second, naming the holder", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });

    const error = await acquire(roots, { env }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LeaseBusyError);
    expect((error as LeaseBusyError).holder?.pid).toBe(process.pid);
    await held.release();

    const after = await acquire(roots, { env });
    await after.release();
  });

  test("separates scopes by the lockfile they own", async () => {
    const project = await acquire(scope(join(home, "manifest.lock.yml")), { env });
    const local = await acquire(scope(join(home, "second.lock.yml")), { env });
    await project.release();
    await local.release();
  });

  test("writes the holder readable only by its owner", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });

    await expectMode(leaseMeta(roots.lock), 0o600);
    await held.release();
  });
});

describe("reclaiming a stale lease", () => {
  test("reclaims a stale lease whose holder has exited", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await heldBy(roots.lock, { pid: await exited() });

    const taken = await acquire(roots, { env });
    await taken.release();
  });

  test("keeps a stale lease whose holder is still running on this host", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await heldBy(roots.lock, { pid: running() });

    // A paused command cannot heartbeat, but taking its scope would lose its write.
    await expect(acquire(roots, { env })).rejects.toThrow(LeaseBusyError);
  });

  test("reclaims a lease silent for ten minutes, whose pid another process may have taken", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await heldBy(roots.lock, { pid: running() });
    await age(roots.lock, 11 * 60_000);

    const taken = await acquire(roots, { env });
    await taken.release();
  });

  test("reclaims a stale lease held from another host by age alone", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await heldBy(roots.lock, { pid: running(), host: "elsewhere.invalid" });

    const taken = await acquire(roots, { env });
    await taken.release();
  });

  test("reclaims a half-written lease that has no readable meta", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });
    await rm(leaseMeta(roots.lock), { force: true });
    await held.release();

    const taken = await acquire(roots, { env });
    await taken.release();
  });

  test("does not release a lease that was reclaimed by someone else", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const mine = await acquire(roots, { env });
    await heldBy(roots.lock, { pid: await exited() });
    const theirs = await acquire(roots, { env });

    // The original holder must not delete the new owner's lease.
    await mine.release();
    expect((await readLease(roots, env))?.id).toBe(theirs.id);
    await theirs.release();
  });
});

describe("waiting for a held lease", () => {
  test("waits for the holder instead of failing when asked to", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });
    let waited: number | undefined;

    const taken = await acquire(roots, {
      env,
      wait: true,
      onWaiting: (holder) => {
        waited = holder?.pid;
        void held.release();
      },
    });

    expect(waited).toBe(process.pid);
    await taken.release();
  });

  test("announces the wait once, not once per poll", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });
    let announcements = 0;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = acquire(roots, { env, wait: true, onWaiting: () => (announcements += 1) });
      // Each poll ends asleep on a timer, so stepping past three sleeps is three polls.
      for (let poll = 0; poll < 3; poll += 1) {
        await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
        await vi.advanceTimersToNextTimerAsync();
      }
      await held.release();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersToNextTimerAsync();
      await (await pending).release();
    } finally {
      vi.useRealTimers();
    }

    expect(announcements).toBe(1);
  });

  test("stops waiting when the signal aborts", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });
    const controller = new AbortController();

    await expect(
      acquire(roots, {
        env,
        wait: true,
        signal: controller.signal,
        onWaiting: () => controller.abort(),
      }),
    ).rejects.toThrow();
    await held.release();
  });
});

describe("where leases live", () => {
  test("excludes writers of one project whatever their aireg home", async () => {
    const roots = scope(join(home, "project", ".registry", "manifest.lock.yml"));
    const other = { AIREG_HOME: join(home, "other-home") };
    const held = await acquire(roots, { env });

    await expect(acquire(roots, { env: other })).rejects.toThrow(LeaseBusyError);
    expect(await readdir(join(home, "project", ".registry", "leases"))).toContain(
      `${leaseKey(roots)}.lease`,
    );
    await held.release();
  });

  test("keeps a project's lease folder out of git", async () => {
    const roots = scope(join(home, "project", ".registry", "manifest.lock.yml"));
    await (await acquire(roots, { env })).release();

    const ignore = join(home, "project", ".registry", "leases", ".gitignore");
    expect(await readFile(ignore, "utf8")).toBe("*\n");
  });
});

describe("clock steps", () => {
  test("reclaims a dead holder's lease whose heartbeat is in the future", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await heldBy(roots.lock, { pid: await exited() });
    const ahead = new Date(Date.now() + 60 * 60_000);
    await utimes(leaseMeta(roots.lock), ahead, ahead);

    const taken = await acquire(roots, { env });
    await taken.release();
  });

  test("reclaims a coordination lock dated in the future", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const coordination = join(home, "leases", ".coordination");
    await mkdir(coordination, { recursive: true });
    const ahead = new Date(Date.now() + 60 * 60_000);
    await utimes(coordination, ahead, ahead);

    const taken = await acquire(roots, { env });
    await taken.release();
  });
});

describe("coordination", () => {
  const coordination = () => join(home, "leases", ".coordination");

  test("waits on a live coordination lock instead of reclaiming it", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await mkdir(coordination(), { recursive: true });
    let settled = false;

    // A pending poll timer is the acquire backing off from a lock it found live.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = acquire(roots, { env }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      expect(settled).toBe(false);
      expect(existsSync(coordination())).toBe(true);

      await rm(coordination(), { recursive: true, force: true });
      await vi.waitFor(() => expect(settled).toBe(true));
      await (await pending).release();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reclaims a coordination lock older than its staleness window", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await mkdir(coordination(), { recursive: true });
    const past = new Date(Date.now() - 10_000);
    await utimes(coordination(), past, past);

    const taken = await acquire(roots, { env });
    await taken.release();
  });
});

describe("withLease", () => {
  test("releases the scope when the body throws", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));

    await expect(
      withLease(roots, { env }, async () => {
        throw new Error("apply failed");
      }),
    ).rejects.toThrow("apply failed");

    const taken = await acquire(roots, { env });
    await taken.release();
  });
});

describe("fencing", () => {
  /** Inside a lease, hands it to another holder the way `unlock` and a new command would. */
  async function takenOver(roots: ReturnType<typeof scope>, theirs: Lease[]): Promise<void> {
    const mine = await readLease(roots, env);
    await breakLease(roots, mine?.id as string, env);
    theirs.push(await acquire(roots, { env }));
  }

  test("stops a holder that lost its lease before it writes the lock", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await writeFile(roots.lock, "theirs\n");
    const theirs: Lease[] = [];

    const error = await withLease(roots, { env }, async () => {
      await takenOver(roots, theirs);
      await writeAtomic(roots.lock, "mine\n");
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LeaseError);
    expect(error).toMatchObject({ reason: "lease_lost", hint: "Run the command again." });
    expect(await readFile(roots.lock, "utf8")).toBe("theirs\n");
    expect((await readdir(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // The new holder keeps the scope.
    expect((await readLease(roots, env))?.id).toBe(theirs[0]?.id);
    await theirs[0]?.release();
  });

  test("lets a holder that keeps its lease write", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    await withLease(roots, { env }, () => writeAtomic(roots.lock, "mine\n"));
    expect(await readFile(roots.lock, "utf8")).toBe("mine\n");
  });

  test("checks every lease a nested write runs under", async () => {
    const outer = scope(join(home, "manifest.lock.yml"));
    const inner = scope(join(home, "second.lock.yml"));
    const theirs: Lease[] = [];

    await expect(
      withLease(outer, { env }, () =>
        withLease(inner, { env }, async () => {
          await takenOver(outer, theirs);
          await writeAtomic(inner.lock, "mine\n");
        }),
      ),
    ).rejects.toMatchObject({ reason: "lease_lost" });
    await theirs[0]?.release();
  });
});

describe("breakLease", () => {
  test("refuses an id that does not match the holder", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });

    await expect(breakLease(roots, "not-the-id", env)).rejects.toThrow(LeaseError);
    expect((await readLease(roots, env))?.id).toBe(held.id);
    await held.release();
  });

  test("breaks the lease when the id matches", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });

    const broken = await breakLease(roots, held.id, env);
    expect(broken.pid).toBe(process.pid);
    expect(await readLease(roots, env)).toBeUndefined();
  });

  test("reports when no lease is held", async () => {
    await expect(breakLease(scope(join(home, "manifest.lock.yml")), "any", env)).rejects.toThrow(
      LeaseError,
    );
  });
});

describe("leaseKey", () => {
  test("treats a symlinked route to one project as the same scope", async () => {
    const real = join(home, "project");
    const via = join(home, "link");
    await mkdir(join(real, ".registry"), { recursive: true });
    await symlink(real, via);

    const lock = (project: string) => join(project, ".registry", "aireg.lock");
    expect(leaseKey({ lock: lock(via) })).toBe(leaseKey({ lock: lock(real) }));

    // Otherwise two processes reaching one project by different paths both write.
    const held = await acquire(scope(lock(real)), { env });
    await expect(acquire(scope(lock(via)), { env })).rejects.toThrow(LeaseBusyError);
    await held.release();
  });

  test("refuses a project's .registry that links elsewhere, creating nothing there", async () => {
    const project = join(home, "cloned");
    const elsewhere = join(home, "elsewhere");
    await mkdir(project, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(project, ".registry"));
    await expect(acquire(scope(join(project, ".registry", "aireg.lock")), { env })).rejects.toThrow(
      "is a symlink in a managed path",
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("treats a route typed in another letter case as the same scope where case does not matter", async () => {
    const real = join(home, "Project");
    await mkdir(real, { recursive: true });
    const typed = join(home, "PROJECT");
    if (!existsSync(typed)) return;
    expect(leaseKey({ lock: join(typed, "manifest.lock.yml") })).toBe(
      leaseKey({ lock: join(real, "manifest.lock.yml") }),
    );
  });
});

describe("meta", () => {
  test("records who holds the scope", async () => {
    const roots = scope(join(home, "manifest.lock.yml"));
    const held = await acquire(roots, { env });

    const holder = JSON.parse(await readFile(leaseMeta(roots.lock), "utf8"));
    expect(holder).toMatchObject({ scope: "project", pid: process.pid });
    // Canonical, so the recorded path is comparable across symlinked routes.
    expect(holder.lock).toBe(join(await realpath(home), "manifest.lock.yml"));
    await held.release();
  });
});
