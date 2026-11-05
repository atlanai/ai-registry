import { afterEach, describe, expect, vi } from "vitest";
import { ensureDaemon, probeDaemon, stopDaemon } from "#daemon/process/lifecycle.ts";
import { readDaemonPid } from "#daemon/process/pid-file.ts";
import { cliClient, RpcClient } from "#daemon/rpc/client.ts";
import { rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { SyncRunner } from "#daemon/runs/runner.ts";
import { DaemonRuntime } from "#daemon/runtime.ts";
import { test } from "#test/kit/fixtures.ts";

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
