import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { envName } from "#core/env.ts";
import { TEST_ROOT, testRoot } from "./temp.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(CLI, "dist", "main.mjs");

function newest(dir: string): { path: string; mtimeMs: number } | undefined {
  let found: { path: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith(".test.ts")) continue;
    const path = join(entry.parentPath, entry.name);
    const { mtimeMs } = statSync(path);
    if (found === undefined || mtimeMs > found.mtimeMs) found = { path, mtimeMs };
  }
  return found;
}

/** The e2e suites spawn the build, so a stale one would test code that is no longer there. */
function assertFreshBuild(): void {
  let built: number;
  try {
    built = statSync(DIST).mtimeMs;
  } catch {
    throw new Error("dist/main.mjs is missing - run `pnpm build` first.");
  }
  const source = newest(join(CLI, "src"));
  if (source !== undefined && source.mtimeMs > built) {
    throw new Error(
      `dist/main.mjs is older than ${relative(CLI, source.path)} - run \`pnpm build\` first.`,
    );
  }
}

async function cwdOf(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
  const { stdout } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

function homeOf(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const prefix = `${envName("HOME")}=`;
  return env.find((pair) => pair.startsWith(prefix))?.slice(prefix.length);
}

/** A daemon chdirs to its HOME, so its cwd (or its AIREG_HOME) says which test started it. */
async function strayDaemons(): Promise<number[]> {
  const roots = [TEST_ROOT, testRoot()];
  const under = (path: string | undefined) =>
    path !== undefined && roots.some((root) => path === root || path.startsWith(`${root}/`));
  const { stdout } = await exec("ps", ["-axo", "pid=,command="]);
  const strays: number[] = [];
  for (const line of stdout.split("\n")) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    if (pid === undefined || !command?.includes("--internal-daemon")) continue;
    try {
      const id = Number(pid);
      if (
        roots.some((root) => command.includes(root)) ||
        under(await cwdOf(id)) ||
        under(homeOf(id))
      )
        strays.push(id);
    } catch {
      // Gone between the listing and the look.
    }
  }
  return strays;
}

function signal(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

async function killStrayDaemons(): Promise<void> {
  if (process.platform === "win32") return;
  const strays = await strayDaemons();
  const alive = strays.filter((pid) => signal(pid, "SIGTERM"));
  const deadline = Date.now() + 3_000;
  while (alive.some((pid) => signal(pid, 0)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of alive) signal(pid, "SIGKILL");
}

export function setup(): () => Promise<void> {
  assertFreshBuild();
  return killStrayDaemons;
}
