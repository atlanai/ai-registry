import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, onTestFinished } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import {
  clearDaemonPid,
  liveDaemonPid,
  readDaemonPid,
  releaseDaemonPid,
  writeDaemonPid,
} from "./pid-file.ts";

describe("daemon pidfile", () => {
  test("round-trips a pid and clears it", async ({ home }) => {
    expect(await readDaemonPid()).toBeUndefined();
    await writeDaemonPid(42);
    expect(await readDaemonPid()).toBe(42);
    expect(await readFile(join(home.aireg, "state", "daemon.pid"), "utf8")).toBe("42\n");
    await clearDaemonPid();
    expect(await readDaemonPid()).toBeUndefined();
  });
});

function fakeDaemon() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "--", "--internal-daemon"], {
    stdio: "ignore",
  });
}

describe.skipIf(process.platform === "win32")("liveDaemonPid", () => {
  test("names another live daemon recorded in the pid file", async ({ tmp }) => {
    const env = { ...process.env, AIREG_HOME: tmp };
    const other = fakeDaemon();
    onTestFinished(() => {
      other.kill();
    });
    await writeDaemonPid(other.pid as number, env);
    await expect(liveDaemonPid(env)).resolves.toBe(other.pid);
  });

  test("ignores its own pid, a process that is gone, and one that is not a daemon", async ({
    tmp,
  }) => {
    const env = { ...process.env, AIREG_HOME: tmp };
    await expect(liveDaemonPid(env)).resolves.toBeUndefined();
    await writeDaemonPid(process.pid, env);
    await expect(liveDaemonPid(env)).resolves.toBeUndefined();
    const gone = fakeDaemon();
    const pid = gone.pid as number;
    await new Promise((resolve) => {
      gone.once("exit", resolve);
      gone.kill();
    });
    await writeDaemonPid(pid, env);
    await expect(liveDaemonPid(env)).resolves.toBeUndefined();
    const plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      stdio: "ignore",
    });
    onTestFinished(() => {
      plain.kill();
    });
    await writeDaemonPid(plain.pid as number, env);
    await expect(liveDaemonPid(env)).resolves.toBeUndefined();
  });
});

describe("releasing the pid file", () => {
  test("removes only its own pid, so a redundant daemon exiting leaves the live one's", async ({
    tmp,
  }) => {
    const env = { ...process.env, AIREG_HOME: tmp };
    await writeDaemonPid(4242, env);
    await releaseDaemonPid(process.pid, env);
    expect(await readDaemonPid(env)).toBe(4242);
    await writeDaemonPid(process.pid, env);
    await releaseDaemonPid(process.pid, env);
    expect(await readDaemonPid(env)).toBeUndefined();
  });
});
