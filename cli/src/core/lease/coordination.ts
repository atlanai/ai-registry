import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ifPresent } from "#adapter/files.ts";
import { stuckError } from "./errors.ts";
import type { Guard } from "./location.ts";

const COORDINATION_STALE_MS = 5_000;

export const POLL_MS = 100;

/** How long removing a stale directory is retried before it is reported. */
export const STUCK_MS = 30_000;

/** What a sleep-wake or file scanner causes on macOS and Windows, and clears by itself. */
const TRANSIENT_RM = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/** False when a transient failure outlasted the retries, leaving the directory to go stale. */
export async function removeDir(dir: string): Promise<boolean> {
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
export function alreadyTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EBUSY"))
  );
}

/** Short-held, so create-versus-reclaim cannot interleave. */
export async function withCoordination<T>(
  parent: string,
  guard: Guard,
  run: () => Promise<T>,
): Promise<T> {
  const dir = join(parent, ".coordination");
  await guard(dir);
  await mkdir(parent, { recursive: true });
  const failing: Failing = {};
  for (;;) {
    const step = await enterOnce(dir, failing, guard);
    if (step === "entered") break;
    if (step === "wait") await new Promise((wake) => setTimeout(wake, POLL_MS));
  }
  try {
    return await run();
  } finally {
    // A leftover lock goes stale and is reclaimed, so it must not fail finished work.
    await guard(dir)
      .then(() => removeDir(dir))
      .catch(() => false);
  }
}

/** Since when entering has kept failing, so a refusal that never clears ends the wait. */
interface Failing {
  since?: number;
}

/** One try at the coordination folder: entered, try again now, or wait a poll first. */
async function enterOnce(
  dir: string,
  failing: Failing,
  guard: Guard,
): Promise<"entered" | "retry" | "wait"> {
  try {
    await mkdir(dir);
    return "entered";
  } catch (error) {
    if (!alreadyTaken(error)) throw error;
    // A delete still pending clears in moments; one that never does is a real refusal.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !stillFailing(failing)) throw error;
    const age = await dirAgeMs(dir);
    if (age === undefined || age <= COORDINATION_STALE_MS) return "wait";
    await guard(dir);
    if (await removeDir(dir)) return "retry";
    if (!stillFailing(failing)) throw stuckError(dir, "lease_coordination_stuck");
    return "wait";
  }
}

function stillFailing(failing: Failing): boolean {
  failing.since ??= Date.now();
  return Date.now() - failing.since < STUCK_MS;
}

/** The coordination lock holds no meta, so its own mtime is its age. */
async function dirAgeMs(dir: string): Promise<number | undefined> {
  const info = await ifPresent(stat(dir));
  return info === undefined ? undefined : Math.abs(Date.now() - info.mtimeMs);
}
