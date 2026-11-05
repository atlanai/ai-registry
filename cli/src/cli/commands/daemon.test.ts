import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, vi } from "vitest";
import type { OutputFormat } from "#core/term/printer.ts";
import { writeDaemonPid } from "#daemon/process/pid-file.ts";
import { rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { PROTOCOL_VERSION } from "#daemon/rpc/methods.ts";
import { commandContext } from "#test/kit/command.ts";
import { test } from "#test/kit/fixtures.ts";
import { daemonAction, run } from "./daemon.ts";

function context(argv: string[], printed: string[], format: OutputFormat = "json") {
  return commandContext(argv, { format, printed, errors: printed });
}

describe("daemonAction", () => {
  test("takes the first word as the action, and status without one", () => {
    expect(daemonAction(["--json", "stop"])).toBe("stop");
    expect(daemonAction(["autostart", "on"])).toBe("autostart");
    expect(daemonAction(["--verbose"])).toBe("status");
    expect(daemonAction(["--", "start"])).toBe("status");
  });
});

/** Answers initialize as aireg 0.1.7 did, before the daemon had to prove it holds the key. */
const OLDER_DAEMON = `
const [path, protocolVersion] = process.argv.slice(1);
require("node:net").createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    const lines = (buffer + chunk).split("\\n");
    buffer = lines.pop();
    for (const message of lines.map((line) => JSON.parse(line))) {
      process.stdout.write("asked " + message.method + "\\n");
      if (message.method !== "initialize") continue;
      const result = {
        protocolVersion: Number(protocolVersion),
        server: { name: "aireg", version: "0.1.7" },
        daemon: { instanceId: "older", startedAtMs: 1, serverNowMs: 2 },
      };
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    }
  });
}).listen(path, () => process.stdout.write("listening\\n"));
`;

interface OlderDaemon {
  pid: number;
  asked: string[];
  exited: Promise<unknown>;
  kill(): void;
}

/** Its own process, with the flag a daemon runs under, and in the pid file as a daemon writes it. */
async function olderDaemon(): Promise<OlderDaemon> {
  const args = ["-e", OLDER_DAEMON, "--", rpcEndpoint(), String(PROTOCOL_VERSION)];
  const child = spawn(process.execPath, [...args, "--internal-daemon"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  await vi.waitFor(() => expect(lines).toContain("listening"));
  const pid = child.pid as number;
  await writeDaemonPid(pid);
  return {
    pid,
    get asked() {
      return lines.filter((line) => line.startsWith("asked ")).map((line) => line.slice(6));
    },
    exited,
    kill: () => child.kill(),
  };
}

describe.skipIf(process.platform === "win32")("an older daemon", () => {
  test("is named with its pid by status, and stopped without being sent anything after initialize", async ({
    home: _,
  }) => {
    const older = await olderDaemon();
    try {
      const text: string[] = [];
      await run(context(["status"], text, "text"));
      expect(text.join("")).toBe(
        `warning: An older aireg daemon is running (pid ${older.pid}), and this aireg cannot talk to it.\n` +
          "hint: Run `aireg daemon restart` to replace it. Commands that need it replace it on their own.\n",
      );
      const json: string[] = [];
      await run(context(["status"], json));
      expect(JSON.parse(json.join("")).data).toMatchObject({ status: "outdated", pid: older.pid });

      const stopped: string[] = [];
      await run(context(["stop"], stopped));
      await older.exited;
      expect(JSON.parse(stopped.join("")).data).toEqual({ status: "down", changed: true });
      expect(new Set(older.asked)).toEqual(new Set(["initialize"]));
    } finally {
      older.kill();
    }
  });
});

describe("daemon stop", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("says under --json that nothing was running and nothing changed", async ({ tmp }) => {
    const home = tmp;
    vi.stubEnv("AIREG_HOME", home);
    const writes: string[] = [];
    await run(context(["stop"], writes));
    expect(JSON.parse(writes.join("")).data).toEqual({ status: "down", changed: false });
  });
});

describe("daemon autostart", () => {
  afterEach(() => vi.unstubAllEnvs());

  const supported = ["darwin", "linux", "win32"].includes(process.platform);

  test.runIf(supported)("reports off for a home that never registered", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    const writes: string[] = [];
    await run(context(["autostart"], writes));
    expect(JSON.parse(writes.join("")).data).toMatchObject({
      supported: true,
      registered: false,
      loaded: false,
    });
  });

  test.skipIf(supported)("reports unsupported on other platforms", async ({ tmp }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    const writes: string[] = [];
    await run(context(["autostart"], writes));
    expect(JSON.parse(writes.join("")).data).toEqual({ supported: false });
  });

  test("rejects an unknown action as a usage error", async () => {
    await expect(run(context(["autostart", "sometimes"], []))).rejects.toMatchObject({
      code: "usage",
      hint: "Use on, off or status.",
    });
  });
});
