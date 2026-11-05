import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NAME } from "#core/product.ts";
import { cliClient, RpcClient } from "#daemon/rpc/client.ts";
import { daemonProof } from "#daemon/rpc/endpoint.ts";
import { FrameDecoder } from "#daemon/rpc/frames.ts";
import { PROTOCOL_VERSION } from "#daemon/rpc/methods.ts";
import { encodeMessage } from "#daemon/rpc/protocol.ts";
import { RpcServer } from "#daemon/rpc/server.ts";
import { homeTest } from "#test/kit/fixtures.ts";

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

  homeTest("waits for a daemon at its client limit instead of failing", async () => {
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

  homeTest(
    "refuses a daemon whose protocol matches but whose initialize omits server.version",
    async () => {
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
    },
  );

  test("sends nothing to a socket another user owns", async () => {
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

interface BareDaemon {
  path: string;
  methods: string[];
  close(): Promise<void>;
}

/** Answers initialize as the daemon does, signing the client's challenge with `sign`. */
async function bareDaemon(sign: (challenge: unknown) => string | undefined): Promise<BareDaemon> {
  const name = `rpc-bare-${randomUUID().slice(0, 8)}`;
  const path =
    process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const peers: Socket[] = [];
  const methods: string[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.push(socket);
    const decoder = new FrameDecoder("the test client");
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const message of decoder.push(bytes)) {
        if ("method" in message) methods.push(message.method);
        if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
          continue;
        }
        const { challenge } = message.params as { challenge?: unknown };
        socket.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              server: { name: NAME, version: "1.0.0" },
              daemon: { instanceId: "d", startedAtMs: 1, serverNowMs: 2 },
              proof: sign(challenge),
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
  return {
    path,
    methods,
    async close() {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      if (process.platform !== "win32") await rm(path, { force: true });
    },
  };
}

homeTest("closes its connection without waiting for the peer to close", async () => {
  const daemon = await bareDaemon(daemonProof);
  let client: RpcClient | undefined;
  try {
    client = await RpcClient.connect(daemon.path, cliClient("1.0.0"));
    const closed = vi.fn();
    client.onClose(closed);
    const pending = client.request("state.snapshot", {});
    void pending.catch(() => {});
    client.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await expect(pending).rejects.toThrow();
  } finally {
    client?.close();
    await daemon.close();
  }
});

homeTest("sends nothing more to a daemon that cannot prove it runs as you", async () => {
  const daemon = await bareDaemon(() => "0".repeat(64));
  try {
    await expect(RpcClient.connect(daemon.path, cliClient("1.0.0"))).rejects.toThrow(
      "could not prove it runs as you",
    );
    expect(daemon.methods).toEqual(["initialize"]);
  } finally {
    await daemon.close();
  }
});
