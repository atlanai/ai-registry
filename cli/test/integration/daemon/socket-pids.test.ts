import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { socketPids } from "#daemon/process/process-info.ts";

/** This process listening on `mine`, and a daemon of another home listening beside it. */
async function twoSockets(): Promise<{ mine: string; other: number | undefined }> {
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
  onTestFinished(async () => {
    other.kill();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  await once(other.stdout, "data");
  return { mine, other: other.pid };
}

describe.skipIf(process.platform === "win32")("socketPids", () => {
  // Every pid it names is sent SIGTERM, so another home's daemon must never be among them.
  test("never names a process holding another socket", async () => {
    const { mine, other } = await twoSockets();
    expect(await socketPids(mine)).not.toContain(other);
  });

  // macOS lsof misses a socket under /var/folders by its path, so only Linux must find it.
  test.runIf(process.platform === "linux")("names the process holding this socket", async () => {
    const { mine } = await twoSockets();
    expect(await socketPids(mine)).toEqual([process.pid]);
  });
});
