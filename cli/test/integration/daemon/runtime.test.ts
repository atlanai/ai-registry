import { afterEach, describe, expect, vi } from "vitest";
import { cliClient } from "#daemon/rpc/client.ts";
import { listening, rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { runDaemon } from "#daemon/runtime.ts";
import { test } from "#test/kit/fixtures.ts";

describe("daemon runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("exits cleanly when another daemon owns the socket, dropping a token it inherited in any case", async ({
    daemon,
  }) => {
    await daemon.start();
    vi.stubEnv("aireg_token_kit", "synthetic-token");
    await expect(runDaemon("test")).resolves.toBe(0);
    expect(process.env.aireg_token_kit).toBeUndefined();
  });

  test("closes on shutdown so a newer CLI can bind", async ({ daemon }) => {
    const { client } = await daemon.start(cliClient("test"));
    expect(await client.request("shutdown", {})).toEqual({ ok: true });
    client.close();
    await vi.waitFor(async () => expect(await listening(rpcEndpoint())).toBe(false));
  });
});
