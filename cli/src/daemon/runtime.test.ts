import { afterEach, describe, expect, vi } from "vitest";
import { cliClient } from "#daemon/rpc/client.ts";
import { listening, rpcEndpoint } from "#daemon/rpc/endpoint.ts";
import { test } from "#test/kit/fixtures.ts";
import { runDaemon } from "./runtime.ts";

describe("daemon runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("exits cleanly when another daemon already owns the socket", async ({ daemon }) => {
    await daemon.start();
    await expect(runDaemon("test")).resolves.toBe(0);
  });

  test("drops every registry token it inherited, whatever its case", async ({ daemon }) => {
    await daemon.start();
    vi.stubEnv("AIREG_TOKEN_ACME", "synthetic-token");
    vi.stubEnv("aireg_token_kit", "synthetic-token");
    vi.stubEnv("Aireg_Token_Kit_Prod", "synthetic-token");
    await expect(runDaemon("test")).resolves.toBe(0);
    expect(Object.keys(process.env).filter((name) => /^aireg_token_/i.test(name))).toEqual([]);
  });

  test("closes on shutdown so a newer CLI can bind", async ({ daemon }) => {
    const { client } = await daemon.start(cliClient("test"));
    expect(await client.request("shutdown", {})).toEqual({ ok: true });
    client.close();
    await vi.waitFor(async () => expect(await listening(rpcEndpoint())).toBe(false));
  });
});
