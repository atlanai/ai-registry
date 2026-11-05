import { formatVersion, gte, parseVersion } from "#adapter/semver.ts";
import { runningEntry } from "#core/release/launch.ts";
import { versionBin } from "#core/release/layout.ts";
import { needsMinimumUpdate } from "#core/release/minimum.ts";
import { isSourceVersion, VERSION } from "#core/version.ts";
import { installedVersion, versionOnDisk } from "#self/install.ts";
import {
  installRelease,
  isInstalledCli,
  probeRelease,
  skipMinimumUpdate,
} from "#self/minimum-update.ts";

export const MIN_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
/** A local readlink, so it can run far more often than the network floor check. */
export const FOLLOW_INTERVAL_MS = 60 * 1000;

export interface DaemonReplaceHooks {
  busy: () => boolean;
  close: () => Promise<void>;
  start: (entry: string, version: string) => Promise<void>;
  /**
   * Set under a service manager, which starts the installed version through the
   * shim. A spawned replacement would be unsupervised, or killed with the service.
   */
  restart?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  current?: string;
}

export interface DaemonMinUpdateHooks extends DaemonReplaceHooks {
  fetch?: typeof fetch;
  skip?: (env: NodeJS.ProcessEnv) => boolean;
  probe?: typeof probeRelease;
  install?: typeof installRelease;
  present?: (version: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

export interface DaemonFollowHooks extends DaemonReplaceHooks {
  skip?: (env: NodeJS.ProcessEnv) => boolean;
  installed?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

/**
 * Keeps an installed daemon on the channel head. A version already on disk is
 * never fetched again, so a rollback holds until a newer release or the floor.
 */
export async function applyDaemonCliUpdate(
  hooks: DaemonMinUpdateHooks,
): Promise<"skip" | "replace"> {
  const env = hooks.env ?? process.env;
  if ((hooks.skip ?? skipMinimumUpdate)(env) || hooks.busy()) return "skip";
  const found = await (hooks.probe ?? probeRelease)(env, hooks.fetch ?? fetch);
  if (found === undefined) return "skip";
  const current = hooks.current ?? VERSION;
  const target = found.version;
  const belowFloor = needsMinimumUpdate(current, found.minimumVersion);
  const newer = !gte(current, target) && !(await (hooks.present ?? versionOnDisk)(target, env));
  if (!belowFloor && !newer) return "skip";
  await (hooks.install ?? installRelease)(found, env, hooks.fetch ?? fetch);
  return replaceWith(hooks, target, env);
}

/** Installs only move `cli/current`; this brings a running daemon onto it. */
export async function applyDaemonFollowInstalled(
  hooks: DaemonFollowHooks,
): Promise<"skip" | "replace"> {
  const env = hooks.env ?? process.env;
  if ((hooks.skip ?? skipFollowInstalled)(env) || hooks.busy()) return "skip";
  const installed = await (hooks.installed ?? runnableInstalledVersion)(env);
  if (installed === undefined || gte(hooks.current ?? VERSION, installed)) return "skip";
  return replaceWith(hooks, installed, env);
}

/** A source run would otherwise swap itself for whatever release is installed. */
function skipFollowInstalled(env: NodeJS.ProcessEnv, entry = runningEntry()): boolean {
  if (parseVersion(VERSION) === undefined || isSourceVersion(VERSION)) return true;
  return !isInstalledCli(entry, env);
}

async function runnableInstalledVersion(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const version = await installedVersion(env);
  const parsed = parseVersion(version);
  if (parsed === undefined || formatVersion(parsed) !== version) return undefined;
  return (await versionOnDisk(version, env)) ? version : undefined;
}

export async function replaceWith(
  hooks: DaemonReplaceHooks,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<"skip" | "replace"> {
  // Asked again after a download: the other check may have replaced us meanwhile.
  if (hooks.busy()) return "skip";
  if (hooks.restart !== undefined) {
    await hooks.restart();
    return "replace";
  }
  await hooks.close();
  try {
    await hooks.start(versionBin(version, env), version);
  } catch (error) {
    process.exitCode = 1;
    throw error;
  }
  return "replace";
}

export class DaemonMinUpdate {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #apply: () => Promise<"skip" | "replace">;
  readonly #intervalMs: number;

  constructor(apply: () => Promise<"skip" | "replace">, intervalMs = MIN_UPDATE_INTERVAL_MS) {
    this.#apply = apply;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      if ((await this.#apply()) === "replace") this.stop();
    } catch {
      // Install failures retry; close() already stopped the timer.
    } finally {
      this.#ticking = false;
    }
  }
}
