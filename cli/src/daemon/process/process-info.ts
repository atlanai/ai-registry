import { readFile } from "node:fs/promises";
import { exec } from "#core/process.ts";
import { DAEMON_FLAG } from "#core/product.ts";

const EXEC_MS = 2_000;
/** PowerShell alone can take a second or two to start. */
const WINDOWS_EXEC_MS = 15_000;

export async function isDaemonProcess(pid: number): Promise<boolean> {
  const command = await commandLine(pid);
  return command !== undefined && isDaemonCommand(command);
}

async function commandLine(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return windowsCommandLine(pid);
  try {
    return (await readFile(`/proc/${String(pid)}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    if (process.platform === "linux") return undefined;
  }
  const { code, stdout } = await exec("ps", ["-p", String(pid), "-o", "args="], {
    timeoutMs: EXEC_MS,
  });
  const line = stdout.trim();
  return code !== 0 || line === "" ? undefined : line;
}

/** Windows has no `ps` or `/proc`; CIM is what still reports another process's command line. */
async function windowsCommandLine(pid: number): Promise<string | undefined> {
  // Interpolated into a PowerShell filter, so only a plain positive integer gets there.
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const { code, stdout } = await exec(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
    ],
    { timeoutMs: WINDOWS_EXEC_MS },
  );
  const line = stdout.trim();
  return code !== 0 || line === "" ? undefined : line;
}

function isDaemonCommand(command: string): boolean {
  return command.includes(DAEMON_FLAG);
}

/** Pids that have this unix socket open. Empty when lsof is missing or the path is idle. */
export async function socketPids(endpoint: string): Promise<number[]> {
  if (process.platform === "win32") return [];
  // lsof ORs its selections unless -a joins them: alone, -U names every process with any unix socket.
  const { code, stdout } = await exec("lsof", ["-a", "-t", "-U", "--", endpoint], {
    timeoutMs: EXEC_MS,
  });
  if (code !== 0) return [];
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
