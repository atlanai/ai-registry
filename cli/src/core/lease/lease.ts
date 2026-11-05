import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { quoted } from "#adapter/text.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { processAlive } from "#core/process.ts";
import { type Roots, type Scope, scopeName } from "#core/store/paths.ts";
import { POLL_MS, removeDir, STUCK_MS, taken, withCoordination } from "./coordination.ts";
import { LeaseBusyError, LeaseError, stuckError, unlockCommand } from "./errors.ts";
import { type LeaseHolder, readHolder } from "./holder.ts";
import {
  asideOf,
  canonicalLock,
  containment,
  type Guard,
  leaseDir,
  metaPath,
  prepare,
} from "./location.ts";

/** A lease older than this with no heartbeat is reclaimable. */
const STALE_MS = 30_000;

/** Silent this long, a same-host holder whose pid still runs is taken to be a reused pid. */
const ABANDONED_MS = 10 * 60_000;

const HEARTBEAT_MS = STALE_MS / 2;

export interface Lease {
  readonly id: string;
  release(): Promise<void>;
}

export interface LeaseOptions {
  /** Wait for a held lease to come free; otherwise a held lease throws `LeaseBusyError`. */
  wait?: boolean;
  onWaiting?: ((holder: LeaseHolder | undefined) => void) | undefined;
  signal?: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Hands back a one-shot command's leases on interrupt, so the next writer need not wait for them
 * to go stale. The daemon drains its runs instead; `alsoStop` ends what the signal cannot reach.
 */
export function releaseLeasesOnInterrupt(alsoStop: () => void): void {
  const interrupted = (signal: NodeJS.Signals) => {
    alsoStop();
    for (const [dir, id] of held) {
      let holder: LeaseHolder | undefined;
      try {
        holder = JSON.parse(readFileSync(metaPath(dir), "utf8")) as LeaseHolder;
      } catch {
        // No metadata yet: the directory is the one this process just made.
      }
      try {
        if (holder === undefined || holder.id === id) {
          renameSync(dir, asideOf(dir, id));
          rmSync(asideOf(dir, id), { recursive: true, force: true });
        }
      } catch {
        // Already gone: nothing of ours to remove.
      }
    }
    held.clear();
    // Die of the signal, unless the command handles it itself.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
}

/** Leases this process holds, by directory, so an interrupt can hand them back. */
const held = new Map<string, string>();

/** A holder that lost its lease must not write its stale snapshot over the new holder's work. */
export async function assertLeasesHeld(): Promise<void> {
  for (const owned of fences.getStore() ?? []) await owned();
}

export async function acquire(
  roots: Pick<Roots, "scope" | "lock">,
  options: LeaseOptions = {},
): Promise<Lease> {
  const env = options.env ?? process.env;
  const dir = leaseDir(roots, env);
  const guard = containment(roots, env);
  await prepare(roots, dir, guard, env);
  const holder: LeaseHolder = {
    id: randomUUID(),
    scope: roots.scope,
    lock: canonicalLock(roots.lock),
    host: hostname(),
    pid: process.pid,
    acquiredAtMs: Date.now(),
  };

  let announced = false;
  let failingSince: number | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const claimed = await withCoordination(dirname(dir), guard, () => claim(dir, holder, guard));
    if (claimed === "taken") {
      const timer = beat(dir, holder.id, guard);
      return { id: holder.id, release: () => releaseOwned(dir, holder.id, timer, guard) };
    }
    const current = await readHolder(dir);
    if (options.wait !== true) throw new LeaseBusyError(current, roots.scope);
    if (claimed === "unremovable") {
      failingSince ??= Date.now();
      if (Date.now() - failingSince >= STUCK_MS) throw stuckError(dir, "lease_stuck");
    }
    if (!announced) {
      announced = true;
      options.onWaiting?.(current);
    }
    await new Promise((wake) => setTimeout(wake, POLL_MS));
  }
}

type Claim = "taken" | "held" | "unremovable";

async function claim(dir: string, holder: LeaseHolder, guard: Guard): Promise<Claim> {
  await guard(dir);
  try {
    await mkdir(dir);
  } catch (error) {
    if (!taken(error)) throw error;
    if (!(await stale(dir))) return "held";
    await guard(dir);
    if (!(await removeDir(dir))) return "unremovable";
    // Another claimant can get there between the remove and this, so it reads as held.
    const made = await mkdir(dir).then(
      () => true,
      (again: unknown) => {
        if (taken(again)) return false;
        throw again;
      },
    );
    if (!made) return "held";
  }
  // Ours from the moment it exists, so an interrupt before the metadata lands still hands it back.
  held.set(dir, holder.id);
  await writeFile(metaPath(dir), `${JSON.stringify(holder, null, 2)}\n`, { mode: PRIVATE_FILE });
  return "taken";
}

async function stale(dir: string): Promise<boolean> {
  const age = await ageMs(dir);
  if (age === undefined || age <= STALE_MS) return false;
  if (age > ABANDONED_MS) return true;
  const holder = await readHolder(dir);
  return holder === undefined || !running(dir, holder);
}

/** Absolute: a clock stepped back leaves an mtime in the future, and that must still age out. */
async function ageMs(dir: string): Promise<number | undefined> {
  try {
    return Math.abs(Date.now() - (await stat(metaPath(dir))).mtimeMs);
  } catch {
    // A half-written acquire must not wedge the scope forever.
    try {
      await stat(dir);
      return Number.POSITIVE_INFINITY;
    } catch {
      return undefined;
    }
  }
}

/**
 * A paused holder cannot heartbeat, so one gone, or on another host, ages out at STALE_MS; one whose
 * pid still runs here keeps its lease until ABANDONED_MS, when that pid is taken to be reused.
 */
function running(dir: string, holder: LeaseHolder): boolean {
  if (holder.host !== hostname()) return false;
  if (holder.pid === process.pid) return held.get(dir) === holder.id;
  return processAlive(holder.pid);
}

/** Ownership checks for the leases the current async call chain runs under. */
const fences = new AsyncLocalStorage<readonly (() => Promise<void>)[]>();

function beat(dir: string, id: string, guard: Guard): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = new Date();
    // A lease reclaimed meanwhile is its new holder's to keep alive, not this one's.
    void guard(dir)
      .then(() => readHolder(dir))
      .then((holder) => (holder?.id === id ? utimes(metaPath(dir), now, now) : undefined))
      .catch(() => {});
  }, HEARTBEAT_MS);
  // Never the reason a one-shot command stays alive.
  timer.unref();
  return timer;
}

async function releaseOwned(
  dir: string,
  id: string,
  timer: NodeJS.Timeout,
  guard: Guard,
): Promise<void> {
  clearInterval(timer);
  // A stale reclaim may have handed the scope to someone else meanwhile.
  const holder = await readHolder(dir);
  // Without a heartbeat a leftover goes stale and is reclaimed, so it must not fail finished work.
  if (holder?.id === id) {
    await guard(dir)
      .then(() => rename(dir, asideOf(dir, id)))
      .then(() => removeDir(asideOf(dir, id)))
      .catch(() => false);
  }
  // Held until it is gone, so an interrupt mid-release still removes it.
  held.delete(dir);
}

/** Guarantees release, so no caller can leave a scope wedged by an early return. */
export async function withLease<T>(
  roots: Pick<Roots, "scope" | "lock">,
  options: LeaseOptions,
  run: () => Promise<T>,
): Promise<T> {
  const lease = await acquire(roots, options);
  const dir = leaseDir(roots, options.env ?? process.env);
  const owned = () => assertOwned(dir, lease.id, roots.scope);
  try {
    return await fences.run([...(fences.getStore() ?? []), owned], run);
  } finally {
    await lease.release();
  }
}

async function assertOwned(dir: string, id: string, scope: Scope): Promise<void> {
  if ((await readHolder(dir))?.id === id) return;
  throw new LeaseError(
    `Another aireg process took over ${scopeName(scope)}, so this command stopped.`,
    "lease_lost",
    "Run the command again.",
  );
}

export async function readLease(
  roots: Pick<Roots, "scope" | "lock">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LeaseHolder | undefined> {
  return readHolder(leaseDir(roots, env));
}

/** The id is a nonce, so a wrong lease cannot be broken blindly. */
export async function breakLease(
  roots: Pick<Roots, "scope" | "lock">,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LeaseHolder> {
  const dir = leaseDir(roots, env);
  // Breaking a lease removes a folder, so it is held to the same containment as taking one.
  const guard = containment(roots, env);
  await guard(dir);
  const holder = await readHolder(dir);
  const again = `Run ${unlockCommand(roots.scope)} to see the current one.`;
  if (holder === undefined) throw new LeaseError("Nothing is locked.");
  if (holder.id !== id) {
    throw new LeaseError(`No lock with id ${quoted(id)}.`, undefined, again);
  }
  await withCoordination(dirname(dir), guard, async () => {
    const current = await readHolder(dir);
    if (current?.id !== id) throw new LeaseError("That lock changed.", undefined, again);
    await guard(dir);
    await rm(dir, { recursive: true, force: true });
  });
  return holder;
}
