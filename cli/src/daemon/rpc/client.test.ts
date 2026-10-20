import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAME } from "#core/product.ts";
import type { RunEvent } from "#core/run/model.ts";
import { cliClient, followRun, RpcClient, RpcClientError, withFreshConfig } from "./client.ts";
import { RpcErrorCode } from "./codes.ts";
import { FrameDecoder } from "./frames.ts";
import { encodeMessage, PROTOCOL_VERSION } from "./protocol.ts";
import { RpcServer } from "./server.ts";

const paths: string[] = [];

function endpoint(): string {
  const path = join(tmpdir(), `aireg-hs-${randomUUID().slice(0, 8)}.sock`);
  paths.push(path);
  return path;
}

describe.skipIf(process.platform === "win32")("rpc handshake", () => {
  afterEach(async () => {
    for (const path of paths.splice(0)) await rm(path, { force: true });
  });

  it("waits for a daemon at its client limit instead of failing", async () => {
    const server = new RpcServer();
    server.method("initialize", async () => ({
      protocolVersion: PROTOCOL_VERSION,
      server: { name: "aireg", version: "1.0.0" },
      daemon: { instanceId: "d", startedAtMs: 1, serverNowMs: 2 },
    }));
    const path = endpoint();
    await server.listen(path);
    const held: Socket[] = [];
    try {
      for (let i = 0; i < 32; i += 1) {
        const socket = createConnection(path);
        await new Promise((resolve) => socket.once("connect", resolve));
        held.push(socket);
      }
      // The client's backoff timer is its sign it was dropped at the limit and is waiting.
      const backoff = vi.spyOn(globalThis, "setTimeout");
      const connecting = RpcClient.connect(path, cliClient("1.0.0"));
      await vi.waitFor(() => expect(backoff).toHaveBeenCalled());
      backoff.mockRestore();
      for (const socket of held.splice(0)) socket.destroy();
      const client = await connecting;
      expect(client.serverVersion).toBe("1.0.0");
      client.close();
    } finally {
      for (const socket of held) socket.destroy();
      await server.close();
    }
  });

  it("refuses a daemon whose protocol matches but whose initialize omits server.version", async () => {
    const server = new RpcServer();
    server.method("initialize", async () => ({
      protocolVersion: PROTOCOL_VERSION,
      server: { name: "aireg" },
      daemon: { instanceId: "d", startedAtMs: 1, serverNowMs: 2 },
    }));
    const path = endpoint();
    await server.listen(path);
    try {
      await expect(RpcClient.connect(path, cliClient("1.0.0"))).rejects.toThrow(/incompatible/);
    } finally {
      await server.close();
    }
  });

  it("sends nothing to a socket another user owns", async () => {
    const server = new RpcServer();
    const asked: string[] = [];
    server.method("initialize", async () => {
      asked.push("initialize");
      return {};
    });
    const path = endpoint();
    await server.listen(path);
    // The socket is this process's, so the client is told it runs as someone else.
    const uid = process.getuid?.() ?? 0;
    const as = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(RpcClient.connect(path, cliClient("1.0.0"))).rejects.toThrow(path);
      expect(asked).toEqual([]);
    } finally {
      as.mockRestore();
      await server.close();
    }
  });
});

it("closes its connection without waiting for the peer to close", async () => {
  const name = `rpc-close-${randomUUID().slice(0, 8)}`;
  const path =
    process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const peers: Socket[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.push(socket);
    const decoder = new FrameDecoder("the test client");
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const message of decoder.push(bytes)) {
        if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
          continue;
        }
        socket.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              server: { name: NAME, version: "1.0.0" },
              daemon: { instanceId: "d", startedAtMs: 1, serverNowMs: 2 },
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  let client: RpcClient | undefined;
  try {
    client = await RpcClient.connect(path, cliClient("1.0.0"));
    const closed = vi.fn();
    client.onClose(closed);
    const pending = client.request("state.snapshot", {});
    void pending.catch(() => {});
    client.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await expect(pending).rejects.toThrow();
  } finally {
    for (const socket of peers) socket.destroy();
    client?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    if (process.platform !== "win32") await rm(path, { force: true });
  }
});

describe("withFreshConfig", () => {
  it("redoes a write against a fresh snapshot while another writer gets there first", async () => {
    let revision = 1;
    const seen: number[] = [];
    const client = {
      request: async (method: string, params: { expectedRevision?: number }) => {
        if (method === "state.snapshot") return { config: { revision } };
        seen.push(params.expectedRevision ?? -1);
        if (seen.length < 3) {
          revision += 1;
          throw new RpcClientError(
            RpcErrorCode.StaleRevision,
            "The settings changed while this command ran. Run it again.",
            {
              revision,
            },
          );
        }
        return { ok: true };
      },
    } as unknown as RpcClient;
    const result = await withFreshConfig(client, (config) =>
      client.request("settings.patch", { expectedRevision: config.revision, paused: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("followRun", () => {
  const event = (id: number, eventType = "item.settled") =>
    ({ id, runId: "run_1", eventType }) as unknown as RunEvent;

  it("shows each stored and broadcast event once, in order, until the run finishes", async () => {
    let notify: (method: string, params: unknown) => void = () => {};
    const client = {
      request: async (method: string) => {
        if (method === "run.events") {
          // A broadcast that lands while the store is read is held until it is caught up.
          notify("run.event", event(2));
          return { events: [event(1), event(2)], hasMore: false };
        }
        setTimeout(() => notify("run.event", event(3, "run.finished")), 5);
        return { run: { state: "running" } };
      },
      onNotification: (listener: typeof notify) => {
        notify = listener;
        return () => {};
      },
      onClose: () => () => {},
    } as unknown as RpcClient;

    const seen: number[] = [];
    await followRun(client, "run_1", (shown) => seen.push(shown.id));
    expect(seen).toEqual([1, 2, 3]);
  });
});
