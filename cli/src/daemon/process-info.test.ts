import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { isDaemonProcess } from "./process-info.ts";

describe("isDaemonProcess", () => {
  test("knows a daemon by its command line, and nothing else", async () => {
    // After `--`, so Node hands the flag to the script instead of reading it as its own.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", "--", "--internal-daemon"],
      { stdio: "ignore" },
    );
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
      expect(await isDaemonProcess(process.pid)).toBe(false);
    } finally {
      child.kill();
    }
  }, 60_000);

  test("never asks about a pid that is not a plain positive integer", async () => {
    expect(await isDaemonProcess(-1)).toBe(false);
    expect(await isDaemonProcess(1.5)).toBe(false);
  });
});
