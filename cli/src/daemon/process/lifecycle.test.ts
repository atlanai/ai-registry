import { closeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { logPath } from "#core/log/sink.ts";
import { cliClient, RpcClient } from "#daemon/rpc/client.ts";
import { rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { SyncRunner } from "#daemon/runs/runner.ts";
import { DaemonRuntime } from "#daemon/runtime.ts";
import { test } from "#test/kit/fixtures.ts";
import { daemonEnv, ensureDaemon, probeDaemon, stderrCapture, stopDaemon } from "./lifecycle.ts";
import { readDaemonPid } from "./pid-file.ts";

const unix = describe.skipIf(process.platform === "win32");

unix("daemon lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  // Its own runtime, as the daemon fixture's is version "test"; closed in a finally since
  // onTestFinished runs only after the fixture has restored the env.
  test("stops an in-process daemon and will not reuse a different package version", async ({
    home: _,
  }) => {
    const runtime = await DaemonRuntime.open("1.2.3");
    await runtime.listen();
    try {
      expect(await readDaemonPid()).toBe(process.pid);
      expect(await probeDaemon("9.9.9")).toEqual({ status: "ready", version: "1.2.3" });
      await ensureDaemon("1.2.3");
      const client = await RpcClient.connect(rpcEndpoint(), cliClient("1.2.3"));
      expect(client.serverVersion).toBe("1.2.3");
      client.close();
      await stopDaemon();
      expect(await probeDaemon("1.2.3")).toEqual({ status: "down" });
      expect(await readDaemonPid()).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  test("says it is stopping while it finishes its runs", async ({ home: _ }) => {
    let finish = () => {};
    vi.spyOn(SyncRunner.prototype, "stop").mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const runtime = await DaemonRuntime.open("1.2.3");
    await runtime.listen();
    const closing = runtime.close();
    try {
      expect(await probeDaemon("1.2.3")).toEqual({ status: "stopping", version: "1.2.3" });
    } finally {
      finish();
      await closing;
    }
  });
});

describe("daemonEnv", () => {
  test("drops the one-command floor opt-out and keeps everything else", () => {
    const env = {
      AIREG_SKIP_MIN_UPDATE: "1",
      AIREG_HOME: "/tmp/home",
      PATH: "/bin",
    };
    expect(daemonEnv(env)).toEqual({ AIREG_HOME: "/tmp/home", PATH: "/bin" });
    expect(env.AIREG_SKIP_MIN_UPDATE).toBe("1");
  });

  test("drops every registry token in any case, so one command's token never outlives that command", () => {
    const env = {
      AIREG_TOKEN_ACME: "synthetic-token",
      AIREG_TOKEN_ACME_PROD: "synthetic-token",
      aireg_token_kit: "synthetic-token",
      AIREG_HOME: "/tmp/home",
    };
    expect(daemonEnv(env)).toEqual({ AIREG_HOME: "/tmp/home" });
  });
});

unix("daemon stderr capture", () => {
  // Trimmed by the daemon itself, so one a service manager started is trimmed too.
  test("opens the capture for appending, keeping what it holds", async ({ home }) => {
    const path = logPath(home.aireg, "daemon-stderr.log");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "small\n");
    const fd = stderrCapture();
    if (fd !== "ignore") closeSync(fd);
    expect(await readFile(path, "utf8")).toBe("small\n");
  });
});
