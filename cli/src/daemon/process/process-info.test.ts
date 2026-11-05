import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { isDaemonProcess, socketPids } from "./process-info.ts";

describe("isDaemonProcess", () => {
  test("knows a daemon by its command line, and nothing else", async () => {
    // After `--`, so Node hands the flag to the script instead of reading it as its own.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", "--", "--internal-daemon"],
      { stdio: "ignore" },
    );
    // Asked alongside the daemon, as each ask starts PowerShell on Windows.
    const self = isDaemonProcess(process.pid);
    try {
      await once(child, "spawn");
      const pid = child.pid ?? 0;
      // A process just spawned may not show its command line for a moment.
      let found = false;
      for (let attempt = 0; attempt < 50 && !found; attempt++) {
        found = await isDaemonProcess(pid);
        if (!found) await delay(100);
      }
      expect(found).toBe(true);
      expect(await self).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("never asks about a pid that is not a plain positive integer", async () => {
    expect(await isDaemonProcess(-1)).toBe(false);
    expect(await isDaemonProcess(1.5)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("socketPids", () => {
  // Every pid it names is sent SIGTERM, so another home's daemon must never be among them.
  test("names only the processes holding this socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aireg-pids-"));
    const mine = join(dir, "mine.sock");
    const server = createServer().listen(mine);
    const other = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))",
        join(dir, "other.sock"),
        "--internal-daemon",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(server, "listening");
      await once(other.stdout, "data");
      const pids = await socketPids(mine);
      expect(pids).not.toContain(other.pid);
      // macOS lsof misses a socket under /var/folders by its path, so only Linux must find it.
      if (process.platform === "linux") expect(pids).toEqual([process.pid]);
    } finally {
      other.kill();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
