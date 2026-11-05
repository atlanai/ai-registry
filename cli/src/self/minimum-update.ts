import { resolve } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { parseVersion } from "#adapter/semver.ts";
import { envName, isCI, isSet } from "#core/env.ts";
import { canonical } from "#core/fs/realpath.ts";
import { handOff } from "#core/process.ts";
import { runningEntry } from "#core/release/launch.ts";
import { cliRoot, versionBin } from "#core/release/layout.ts";
import { needsMinimumUpdate } from "#core/release/minimum.ts";
import type { Printer } from "#core/term/printer.ts";
import { isSourceVersion, VERSION } from "#core/version.ts";
import { installBinary, pruneOld } from "./install.ts";
import {
  describeSize,
  downloadRelease,
  downloadSize,
  type ResolvedRelease,
  resolveRelease,
} from "./release.ts";
import { cacheFrom, readUpdateCache, writeUpdateCache } from "./update-cache.ts";

/** 0.15 MB/s, a slow link that works; a forced update that times out stays below the floor. */
const SLOW_LINK_BYTES_PER_MS = 150;
const MIN_INSTALL_TIMEOUT_MS = 600_000;
/** Above the largest release so far, for a manifest that states no size. */
const ASSUMED_DOWNLOAD_BYTES = 128 * 1024 * 1024;
/** A command below the floor waits on this probe, so it stays short. */
const PROBE_TIMEOUT_MS = 2000;

export function isInstalledCli(
  entry: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (entry === undefined) return false;
  // Both resolved, so a home under a symlinked path still contains its own CLI.
  const root = canonical(resolve(cliRoot(env)));
  const path = canonical(resolve(entry));
  return path !== root && isWithin(root, path);
}

export function skipMinimumUpdate(
  env: NodeJS.ProcessEnv = process.env,
  entry = runningEntry(),
): boolean {
  if (isCI(env) || isSet("DISABLE_UPDATE_CHECK", env) || isSet("SKIP_MIN_UPDATE", env)) return true;
  if (parseVersion(VERSION) === undefined || isSourceVersion(VERSION)) return true;
  return !isInstalledCli(entry, env);
}

/** Moves a running daemon onto the CLI at `entry`; passed in, since the daemon sits above self. */
export type RecycleDaemon = (entry: string, version: string) => Promise<void>;

/** Every answer is recorded, so the next run's floor check reads it instead of asking. */
export async function probeRelease(
  env: NodeJS.ProcessEnv = process.env,
  $fetch: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ResolvedRelease | undefined> {
  try {
    const release = await resolveRelease(env, $fetch, timeoutMs);
    await writeUpdateCache(cacheFrom(release), env).catch(() => undefined);
    return release;
  } catch {
    return undefined;
  }
}

export async function installRelease(
  release: ResolvedRelease,
  env: NodeJS.ProcessEnv = process.env,
  $fetch: typeof fetch = fetch,
): Promise<void> {
  const timeoutMs = installTimeoutMs(downloadSize(release));
  const bytes = await downloadRelease(release, $fetch, timeoutMs);
  await installBinary(release.version, bytes, env);
  await pruneOld(env);
}

export function installTimeoutMs(sizeBytes: number | undefined): number {
  const bytes = sizeBytes ?? ASSUMED_DOWNLOAD_BYTES;
  return Math.max(MIN_INSTALL_TIMEOUT_MS, Math.ceil(bytes / SLOW_LINK_BYTES_PER_MS));
}

export type MinimumUpdate = { kind: "skip" } | { kind: "reexec"; code: number };

export async function applyMinimumUpdate(
  printer: Printer,
  argv: string[],
  recycle: RecycleDaemon,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MinimumUpdate> {
  if (skipMinimumUpdate(env)) return { kind: "skip" };
  // The cache only says to look; what gets installed comes from a freshly verified manifest.
  if (!needsMinimumUpdate(VERSION, (await readUpdateCache(env))?.minimumVersion)) {
    return { kind: "skip" };
  }
  const found = await probeRelease(env);
  const floor = found?.minimumVersion;
  if (found === undefined || floor === undefined || !needsMinimumUpdate(VERSION, floor)) {
    return { kind: "skip" };
  }

  // Said before the download, not after: this is unattended, and a silent multi-minute stall
  // reads as a hang.
  printer.hint(
    `aireg ${VERSION} is older than the oldest supported version, ${floor}. Updating to ${found.version}${describeSize(downloadSize(found))}.`,
  );
  await installRelease(found, env);
  await recycle(versionBin(found.version, env), found.version);
  return { kind: "reexec", code: await reexec(found.version, argv, env) };
}

/**
 * The new version is a different executable at a different path, so this is an
 * ordinary spawn of it - the process that just wrote it is still the old one.
 */
function reexec(version: string, argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return handOff(versionBin(version, env), argv, { ...env, [envName("SKIP_MIN_UPDATE")]: "1" });
}
