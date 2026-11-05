import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { envName, withoutTokens } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { withLease } from "#core/lease/lease.ts";
import { DAEMON_STDERR_FILE, logPath } from "#core/log/sink.ts";
import { spawnDetached } from "#core/process.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";
import { ensureHome } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import { NO_EXECUTABLE, startManaged } from "#daemon/autostart/index.ts";
import { cliClient, RpcClient, UnprovenDaemonError } from "#daemon/rpc/client.ts";
import { assertOwnSocket, listening, privateDirectory, rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { clearDaemonPid, liveDaemonPid, readDaemonPid } from "./pid-file.ts";
import { isDaemonProcess, socketPids } from "./process-info.ts";

const START_MS = 5_000;
const STOP_MS = 5_000;
const SIGNAL_MS = 3_000;

export type DaemonProbe =
  | { status: "down" }
  | { status: "ready"; version: string }
  | { status: "stopping"; version: string }
  | { status: "outdated"; pid: number }
  | { status: "foreign" };

/** How long a listening daemon may take to answer before it counts as foreign. */
const ANSWER_MS = 1_500;

export async function probeDaemon(clientVersion: string): Promise<DaemonProbe> {
  // Refused outright: a socket someone else planted is not a daemon to stop.
  await assertOwnSocket(rpcEndpoint());
  // A daemon still starting, or busy, listens before it answers, so one failed handshake is not foreign.
  const deadline = Date.now() + ANSWER_MS;
  for (;;) {
    if (!(await listening(rpcEndpoint()))) return { status: "down" };
    try {
      const client = await RpcClient.connect(rpcEndpoint(), cliClient(clientVersion));
      const { serverVersion: version, stopping } = client;
      client.close();
      return { status: stopping ? "stopping" : "ready", version };
    } catch (error) {
      // It answered without the proof, and asking again will not change that.
      if (error instanceof UnprovenDaemonError) return unproven();
      if (Date.now() >= deadline) return { status: "foreign" };
      await sleep(100);
    }
  }
}

/** Told apart from a foreign program by this home's pid file and that process's command line. */
async function unproven(): Promise<DaemonProbe> {
  const pid = await liveDaemonPid();
  return pid === undefined ? { status: "foreign" } : { status: "outdated", pid };
}

export async function stopDaemon(endpoint = rpcEndpoint()): Promise<void> {
  if (!(await listening(endpoint))) {
    await clearDaemonPid();
    return;
  }
  if ((await askShutdown(endpoint)) && (await waitUntilDown(endpoint, STOP_MS))) {
    await clearDaemonPid();
    return;
  }
  await signalListener(endpoint);
  if (await waitUntilDown(endpoint, SIGNAL_MS)) {
    await clearDaemonPid();
    return;
  }
  throw new AiregError("The aireg daemon did not stop.", {
    code: ErrorCode.Unavailable,
    hint: "Run `aireg logs --daemon` to see why.",
  });
}

/** False for a daemon that cannot prove itself, which only a signal stops. */
async function askShutdown(endpoint: string): Promise<boolean> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(endpoint, cliClient(VERSION));
  } catch (error) {
    return !(error instanceof UnprovenDaemonError);
  }
  try {
    await client.request("shutdown", {}, { timeoutMs: STOP_MS });
  } catch {
    // SIGTERM still runs if the socket is up and RPC is not.
  } finally {
    client.close();
  }
  return true;
}

async function waitUntilDown(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listening(endpoint))) return true;
    await sleep(50);
  }
  return !(await listening(endpoint));
}

async function signalListener(endpoint: string): Promise<void> {
  const pids = new Set<number>();
  const written = await readDaemonPid();
  if (written !== undefined) pids.add(written);
  for (const pid of await socketPids(endpoint)) pids.add(pid);
  for (const pid of pids) await terminate(pid);
}

async function terminate(pid: number): Promise<void> {
  if (pid === process.pid) return;
  if (!(await isDaemonProcess(pid))) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Anything reaching stderr escaped the logger, and is all a daemon dying on startup leaves.
 * Opened for appending, so the daemon can trim it in place when it starts.
 */
export function stderrCapture(): number | "ignore" {
  try {
    const path = logPath(ensureHome(), DAEMON_STDERR_FILE);
    mkdirSync(dirname(path), { recursive: true });
    // 0600 like every other log: a stack trace carries paths and arguments.
    return openSync(path, "a", PRIVATE_FILE);
  } catch {
    return "ignore";
  }
}

export async function startDaemon(entry: string, version: string): Promise<void> {
  // With autostart on, the service manager owns the process; a spawn beside it would be unsupervised.
  if (await startManaged()) {
    if (await waitFor(version, START_MS)) return;
    // The service runs whatever its definition names, so another version gives way to this one.
    await stopDaemon();
  }
  // Here as well as in the daemon, so a directory it would refuse is named to the user.
  await privateDirectory(dirname(rpcEndpoint()));
  const launch = launchArgv(entry, ["--internal-daemon"]);
  const stderr = stderrCapture();
  try {
    spawnDetached(launch.command, launch.args, {
      stdio: ["ignore", "ignore", stderr],
      env: daemonEnv(process.env),
    });
  } finally {
    // The child holds its own copy; this one would stay open for as long as the CLI runs.
    if (stderr !== "ignore") closeSync(stderr);
  }
  if (!(await waitFor(version, START_MS))) {
    throw new AiregError(`The aireg daemon did not start within ${START_MS / 1000} seconds.`, {
      code: ErrorCode.Unavailable,
      hint: "Run `aireg logs --stderr` to see why.",
    });
  }
}

async function waitFor(version: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await probeDaemon(version);
    if (found.status === "ready" && found.version === version) return true;
    await sleep(50);
  }
  return false;
}

/**
 * What one command was given stays with it: a floor check turned off after a self update,
 * and any `AIREG_TOKEN_<NAME>`, which would otherwise reach every later job the daemon runs.
 */
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [envName("SKIP_MIN_UPDATE")]: _skip, ...rest } = withoutTokens(env);
  return rest;
}

/** Starts the daemon if it is not running, and hands `work` a connection closed however it ends. */
export async function withDaemon<T>(work: (client: RpcClient) => Promise<T>): Promise<T> {
  await ensureDaemon(VERSION);
  const client = await RpcClient.connect(rpcEndpoint(), cliClient(VERSION));
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

export async function ensureDaemon(version: string): Promise<void> {
  if (await current(version)) return;
  // One starter at a time, or parallel commands each start a daemon and stop the others as foreign.
  ensureHome();
  await withLease({ scope: "user", lock: rpcEndpoint() }, { wait: true }, async () => {
    if (await current(version)) return;
    const found = await probeDaemon(version);
    if (found.status !== "down") await stopDaemon();
    const entry = runningEntry();
    if (entry === undefined) throw new Error(NO_EXECUTABLE);
    await startDaemon(entry, version);
  });
}

async function current(version: string): Promise<boolean> {
  const found = await probeDaemon(version);
  return found.status === "ready" && found.version === version;
}

export async function recycleDaemon(entry: string, version: string): Promise<void> {
  if ((await probeDaemon(version)).status === "down") return;
  await stopDaemon();
  await startDaemon(entry, version);
}
