import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { envName, setting } from "#core/env.ts";
import { canonical } from "#core/fs/canonical.ts";
import { userHome } from "#core/fs/path.ts";
import { DAEMON_STDERR_FILE, logPath } from "#core/log/index.ts";
import { exec } from "#core/process.ts";
import { HOME_DIR } from "#core/product.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";
import { cliRoot, shimPath } from "#core/release/layout.ts";
import { toolHome } from "#core/store/paths.ts";
import { homeIdentity } from "#daemon/rpc/endpoint.ts";
import { launchdBackend } from "./launchd.ts";
import {
  type AutostartBackend,
  type AutostartState,
  type Exec,
  type ServiceSpec,
  SUPERVISOR_ENV,
} from "./model.ts";
import { runKeyBackend } from "./run-key.ts";
import { systemdBackend } from "./systemd.ts";

export { type AutostartState, RESTART_EXIT_CODE } from "./model.ts";

const EXEC_MS = 15_000;

export interface AutostartOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: Exec;
  entry?: string;
  execPath?: string;
  uid?: number;
  /** The account's own home, from the user database rather than `$HOME`. */
  accountHome?: string;
}

const defaultExec: Exec = (file, args) => exec(file, args, { timeoutMs: EXEC_MS });

/** True in a daemon a service manager started, which will start it again after a non-zero exit. */
export function supervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[SUPERVISOR_ENV];
  return value !== undefined && value !== "";
}

/**
 * A standalone build runs from a versioned directory that pruning deletes, so the service
 * names what PATH finds, which every update replaces: the shim, or on Windows the copy.
 */
function stableEntry(entry: string, env: NodeJS.ProcessEnv): string {
  if (!isWithin(cliRoot(env), entry)) return entry;
  return existsSync(shimPath(env)) ? shimPath(env) : entry;
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * `execPath` is resolved, so it can name a versioned directory that an
 * upgrade deletes; the PATH entry linking to it survives.
 */
function stableNode(execPath: string, path: string | undefined): string {
  const target = real(execPath);
  if (target === undefined || path === undefined) return execPath;
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, basename(execPath));
    if (real(candidate) === target) return candidate;
  }
  return execPath;
}

export const NO_EXECUTABLE = "aireg cannot find its own executable, so it cannot start the daemon.";

export function serviceSpec(options: AutostartOptions = {}): ServiceSpec {
  const env = options.env ?? process.env;
  const entry = options.entry ?? runningEntry();
  if (entry === undefined) throw new Error(NO_EXECUTABLE);
  const execPath = stableNode(options.execPath ?? process.execPath, env.PATH);
  const stable = stableEntry(entry, env);
  const argv = (args: string[]) => {
    const launch = launchArgv(stable, args, execPath);
    return [launch.command, ...launch.args];
  };

  const home = toolHome(env);
  // Compared with the account's real home, so a second HOME gets its own service rather than replacing yours.
  const account = canonical(join(canonical(options.accountHome ?? userInfo().homedir), HOME_DIR));
  const overridden = home !== account;
  const user = userHome(env);
  const xdg = env.XDG_CONFIG_HOME;
  const service: Record<string, string> = {};
  // A service manager starts with a bare PATH, and git sources need `git` on it.
  if (env.PATH !== undefined && env.PATH !== "") service.PATH = env.PATH;
  if (overridden) service[envName("HOME")] = home;
  // It moves only your user scope, so the service needs it too.
  const scope = setting("USER_SCOPE", env);
  if (scope !== undefined) service[envName("USER_SCOPE")] = scope;

  return {
    suffix: overridden ? homeIdentity(home) : "",
    daemon: argv(["--internal-daemon"]),
    starter: argv(["daemon", "start"]),
    env: service,
    stderrLog: logPath(home, DAEMON_STDERR_FILE),
    home: user,
    configHome: xdg !== undefined && isAbsolute(xdg) ? xdg : join(user, ".config"),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1),
  };
}

/** Undefined where this CLI knows no per-user login mechanism. */
function backendFor(options: AutostartOptions): AutostartBackend | undefined {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  if (platform === "darwin") return launchdBackend(serviceSpec(options), exec);
  if (platform === "linux") return systemdBackend(serviceSpec(options), exec);
  if (platform === "win32") return runKeyBackend(serviceSpec(options), exec);
  return undefined;
}

export async function autostartState(
  options: AutostartOptions = {},
): Promise<AutostartState | undefined> {
  return backendFor(options)?.state();
}

export interface AutostartChange {
  changed: boolean;
  state: AutostartState;
}

/**
 * Idempotent. `stopDaemon` hands a daemon started by hand over to the service
 * manager: left running it would hold the socket and the managed one would exit.
 */
export async function enableAutostart(
  stopDaemon: () => Promise<void>,
  options: AutostartOptions = {},
): Promise<AutostartChange | undefined> {
  const backend = backendFor(options);
  if (backend === undefined) return undefined;
  const before = await backend.state();
  if (before.registered && before.loaded && before.current)
    return { changed: false, state: before };
  if (backend.supervises) await stopDaemon();
  await backend.install();
  return { changed: true, state: await backend.state() };
}

/** Unloading stops a managed daemon too; the next command that needs one starts it by hand. */
export async function disableAutostart(
  options: AutostartOptions = {},
): Promise<AutostartChange | undefined> {
  const backend = backendFor(options);
  if (backend === undefined) return undefined;
  const changed = await backend.uninstall();
  return { changed, state: await backend.state() };
}

/** False, never an error, so a broken service definition falls back to a plain spawn. */
export async function startManaged(options: AutostartOptions = {}): Promise<boolean> {
  try {
    return (await backendFor(options)?.start()) ?? false;
  } catch {
    return false;
  }
}
