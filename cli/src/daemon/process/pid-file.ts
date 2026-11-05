import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { processAlive } from "#core/process.ts";
import { ensureHome, stateDir } from "#core/store/paths.ts";
import { isDaemonProcess } from "./process-info.ts";

export async function writeDaemonPid(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await mkdir(join(ensureHome(env), "state"), { recursive: true });
  await writeFile(daemonPidPath(env), `${String(pid)}\n`, { encoding: "utf8", mode: PRIVATE_FILE });
}

function daemonPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "daemon.pid");
}

export async function readDaemonPid(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(daemonPidPath(env), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function clearDaemonPid(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(daemonPidPath(env), { force: true });
}

/** A daemon that never bound, or was replaced, must not remove the running one's record. */
export async function releaseDaemonPid(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if ((await readDaemonPid(env)) === pid) await clearDaemonPid(env);
}

/**
 * Another daemon that owns this home, from the pid file it wrote on binding.
 * The socket probe alone misses a daemon too busy starting up to answer.
 */
export async function liveDaemonPid(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  const pid = await readDaemonPid(env);
  if (pid === undefined || pid === process.pid || !processAlive(pid)) return undefined;
  return (await isDaemonProcess(pid)) ? pid : undefined;
}
