import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import { quoted } from "#adapter/text.ts";
import { shortHash } from "#core/fs/hash.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { ensureHome, leasesDir, type Roots, type Scope } from "#core/store/paths.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import { processAlive } from "./process.ts";

/** A lease older than this with no heartbeat is reclaimable. */
const STALE_MS = 30_000;
/** Silent this long, a same-host holder whose pid still runs is taken to be a reused pid. */
const ABANDONED_MS = 10 * 60_000;
const HEARTBEAT_MS = STALE_MS / 2;
const COORDINATION_STALE_MS = 5_000;
const POLL_MS = 100;
/** How long a stale directory that cannot be removed is retried before it is reported. */
const STUCK_MS = 30_000;

export interface LeaseHolder {
  id: string;
  scope: string;
  lock: string;
  host: string;
  pid: number;
  acquiredAtMs: number;
}

function where(scope: Scope): string {
  return scope === "user" ? "your user scope" : "this project";
}

function unlockCommand(scope: Scope): string {
  return `\`aireg unlock${scope === "user" ? " -g" : ""}\``;
}

/** Thrown instead of waiting, so a scheduled run can skip rather than pile up. */
export class LeaseBusyError extends AiregError {
  readonly holder: LeaseHolder | undefined;

  constructor(holder: LeaseHolder | undefined, scope: Scope) {
    super(`Another aireg process is writing to ${where(scope)}.`, {
      code: ErrorCode.Busy,
      hint: `Wait for it to finish, or run ${unlockCommand(scope)} if it has stopped.`,
    });
    this.name = "LeaseBusyError";
    this.holder = holder;
  }
}

export class LeaseError extends AiregError {
  /** Why the lease failed, for the daemon to tell a lost lease from a stuck one. */
  readonly reason: string | undefined;

  constructor(message: string, reason?: string, hint?: string) {
    super(message, { code: ErrorCode.Busy, hint });
    this.name = "LeaseError";
    this.reason = reason;
  }
}

function stuckError(dir: string, code: string): LeaseError {
  return new LeaseError(
    `Could not remove the stale lock folder ${dir}.`,
    code,
    "Remove it by hand, then run the command again.",
  );
}

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
 * Canonical, because `/tmp` and `/private/tmp`, or `~/Desktop` and `~/desktop`, reaching one
 * project must not take two leases. The lock may not exist yet, so resolve the closest folder that does.
 */
function canonicalLock(lock: string): string {
  const full = resolve(lock);
  const rest = [basename(full)];
  for (let dir = dirname(full); ; dir = dirname(dir)) {
    try {
      return join(realpathSync.native(dir), ...rest);
    } catch {
      if (dirname(dir) === dir) return full;
      rest.unshift(basename(dir));
    }
  }
}

/** The lockfile path names the file set a scope owns, so it is the identity. */
export function leaseKey(roots: Pick<Roots, "lock">): string {
  return shortHash(canonicalLock(roots.lock));
}

/**
 * In the project's own `.registry/`, so every writer of the project shares it
 * whatever its `AIREG_HOME`. The user scope's stay in `AIREG_HOME`.
 */
function parentOf(roots: Pick<Roots, "scope" | "lock">, env: NodeJS.ProcessEnv): string {
  return roots.scope === "user"
    ? leasesDir(env)
    : join(dirname(canonicalLock(roots.lock)), "leases");
}

function leaseDir(roots: Pick<Roots, "scope" | "lock">, env: NodeJS.ProcessEnv): string {
  return join(parentOf(roots, env), `${leaseKey(roots)}.lease`);
}

/**
 * A project's `.registry/` is committed, so its lease folder ignores itself, and a
 * `.registry` link out of the project is refused as every other scope write refuses it.
 */
async function prepare(
  roots: Pick<Roots, "scope" | "lock">,
  parent: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const user = roots.scope === "user";
  if (user) ensureHome(env);
  else {
    // The scope folder alone: a symlinked route to the project itself is still one project.
    const folder = dirname(resolve(roots.lock));
    await assertUnredirected(folder, folder);
  }
  await mkdir(parent, { recursive: true });
  if (user) return;
  await writeFile(join(parent, ".gitignore"), "*\n", { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

function metaPath(dir: string): string {
  return join(dir, "meta.json");
}

async function readHolder(dir: string): Promise<LeaseHolder | undefined> {
  try {
    return JSON.parse(await readFile(metaPath(dir), "utf8")) as LeaseHolder;
  } catch {
    return undefined;
  }
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

/** Leases this process holds, by directory, so an interrupt can hand them back. */
const held = new Map<string, string>();

/**
 * A paused holder cannot heartbeat, so one gone, or on another host, ages out at STALE_MS; one whose
 * pid still runs here keeps its lease until ABANDONED_MS, when that pid is taken to be reused.
 */
function running(dir: string, holder: LeaseHolder): boolean {
  if (holder.host !== hostname()) return false;
  if (holder.pid === process.pid) return held.get(dir) === holder.id;
  return processAlive(holder.pid);
}

async function stale(dir: string): Promise<boolean> {
  const age = await ageMs(dir);
  if (age === undefined || age <= STALE_MS) return false;
  if (age > ABANDONED_MS) return true;
  const holder = await readHolder(dir);
  return holder === undefined || !running(dir, holder);
}

/** The coordination lock holds no meta, so its own mtime is its age. */
async function dirAgeMs(dir: string): Promise<number | undefined> {
  try {
    return Math.abs(Date.now() - (await stat(dir)).mtimeMs);
  } catch {
    return undefined;
  }
}

/** What a sleep-wake or file scanner causes on macOS and Windows, and clears by itself. */
const TRANSIENT_RM = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/** False when a transient failure outlasted the retries, leaving the directory to go stale. */
async function removeDir(dir: string): Promise<boolean> {
  try {
    // Node retries the transient codes itself; `force` treats a missing directory as removed.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch (error) {
    if (TRANSIENT_RM.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Windows answers EPERM, not EEXIST, for a folder another process is still deleting. */
function taken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EBUSY"))
  );
}

/** Since when entering has kept failing, so a refusal that never clears ends the wait. */
interface Failing {
  since?: number;
}

function stillFailing(failing: Failing): boolean {
  failing.since ??= Date.now();
  return Date.now() - failing.since < STUCK_MS;
}

/** One try at the coordination folder: entered, try again now, or wait a poll first. */
async function enterOnce(dir: string, failing: Failing): Promise<"entered" | "retry" | "wait"> {
  try {
    await mkdir(dir);
    return "entered";
  } catch (error) {
    if (!taken(error)) throw error;
    // A delete still pending clears in moments; one that never does is a real refusal.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !stillFailing(failing)) throw error;
    const age = await dirAgeMs(dir);
    if (age === undefined || age <= COORDINATION_STALE_MS) return "wait";
    if (await removeDir(dir)) return "retry";
    if (!stillFailing(failing)) throw stuckError(dir, "lease_coordination_stuck");
    return "wait";
  }
}

/** Short-held, so create-versus-reclaim cannot interleave. */
async function withCoordination<T>(parent: string, run: () => Promise<T>): Promise<T> {
  const dir = join(parent, ".coordination");
  await mkdir(parent, { recursive: true });
  const failing: Failing = {};
  for (;;) {
    const step = await enterOnce(dir, failing);
    if (step === "entered") break;
    if (step === "wait") await new Promise((wake) => setTimeout(wake, POLL_MS));
  }
  try {
    return await run();
  } finally {
    // A leftover lock goes stale and is reclaimed, so it must not fail finished work.
    await removeDir(dir).catch(() => false);
  }
}

type Claim = "taken" | "held" | "unremovable";

async function claim(dir: string, holder: LeaseHolder): Promise<Claim> {
  try {
    await mkdir(dir);
  } catch (error) {
    if (!taken(error)) throw error;
    if (!(await stale(dir))) return "held";
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
        if (holder === undefined || holder.id === id) rmSync(dir, { recursive: true, force: true });
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

function beat(dir: string): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(metaPath(dir), now, now).catch(() => {});
  }, HEARTBEAT_MS);
  // Never the reason a one-shot command stays alive.
  timer.unref();
  return timer;
}

async function assertOwned(dir: string, id: string, scope: Scope): Promise<void> {
  if ((await readHolder(dir))?.id === id) return;
  throw new LeaseError(
    `Another aireg process took over ${where(scope)}, so this command stopped.`,
    "lease_lost",
    "Run the command again.",
  );
}

/** Ownership checks for the leases the current async call chain runs under. */
const fences = new AsyncLocalStorage<readonly (() => Promise<void>)[]>();

/** A holder that lost its lease must not write its stale snapshot over the new holder's work. */
export async function assertLeasesHeld(): Promise<void> {
  for (const owned of fences.getStore() ?? []) await owned();
}

async function releaseOwned(dir: string, id: string, timer: NodeJS.Timeout): Promise<void> {
  clearInterval(timer);
  // A stale reclaim may have handed the scope to someone else meanwhile.
  const holder = await readHolder(dir);
  // Without a heartbeat a leftover goes stale and is reclaimed, so it must not fail finished work.
  if (holder?.id === id) await removeDir(dir).catch(() => false);
  // Held until it is gone, so an interrupt mid-release still removes it.
  held.delete(dir);
}

export async function acquire(
  roots: Pick<Roots, "scope" | "lock">,
  options: LeaseOptions = {},
): Promise<Lease> {
  const env = options.env ?? process.env;
  const dir = leaseDir(roots, env);
  await prepare(roots, dirname(dir), env);
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
    const claimed = await withCoordination(dirname(dir), () => claim(dir, holder));
    if (claimed === "taken") {
      const timer = beat(dir);
      return { id: holder.id, release: () => releaseOwned(dir, holder.id, timer) };
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
  const holder = await readHolder(dir);
  const again = `Run ${unlockCommand(roots.scope)} to see the current one.`;
  if (holder === undefined) throw new LeaseError("Nothing is locked.");
  if (holder.id !== id) {
    throw new LeaseError(`No lock with id ${quoted(id)}.`, undefined, again);
  }
  await withCoordination(dirname(dir), async () => {
    const current = await readHolder(dir);
    if (current?.id !== id) throw new LeaseError("That lock changed.", undefined, again);
    await rm(dir, { recursive: true, force: true });
  });
  return holder;
}
