import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { isDaemonProcess } from "./process-info.ts";

describe("isDaemonProcess", () => {
  test("knows a daemon by its command line, and nothing else", async () => {
    // After `--`, so Node hands the flag to the script.
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--internal-daemon"],
      { stdio: "ignore" },
    );
    // In parallel, since each ask starts PowerShell on Windows.
    const self = isDaemonProcess(process.pid);
    try {
      await once(child, "spawn");
      const pid = child.pid ?? 0;
      // A process just spawned may not show its command line for a moment, and on a busy
      // Windows runner one ask can take many seconds, so this waits by the clock, not by tries.
      const deadline = Date.now() + 40_000;
      let found = await isDaemonProcess(pid);
      while (!found && Date.now() < deadline) {
        await delay(100);
        found = await isDaemonProcess(pid);
      }
      expect(found).toBe(true);
      expect(await self).toBe(false);
    } finally {
      child.kill();
    }
  }, 60_000);

  test("never asks about a pid that is not a plain positive integer", async () => {
    expect(await isDaemonProcess(-1)).toBe(false);
    expect(await isDaemonProcess(1.5)).toBe(false);
  });
});
