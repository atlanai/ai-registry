import { randomUUID } from "node:crypto";
import { link, lstat, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RunEvent } from "#core/run/model.ts";
import { RunEventType } from "#core/run/model.ts";
import { RpcErrorCode } from "./codes.ts";
import { PROTOCOL_VERSION } from "./methods.ts";
import { DaemonAlreadyRunningError, RpcServer } from "./server.ts";

const paths: string[] = [];

/** Socket paths are length-limited, so they go straight in the temp root under a short name. */
function endpoint(): string {
  const path = join(tmpdir(), `aireg-rpc-${randomUUID().slice(0, 8)}.sock`);
  paths.push(path);
  return path;
}

/** A hard link outlives the listener's own unlink, leaving a socket nothing answers on. */
async function orphaned(): Promise<string> {
  const bound = endpoint();
  const path = endpoint();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(bound, resolve));
  await link(bound, path);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return path;
}

describe.skipIf(process.platform === "win32")("rpc server endpoints", () => {
  afterEach(async () => {
    for (const path of paths.splice(0)) await rm(path, { force: true });
  });

  test("replaces a socket left behind by a daemon that is gone", async () => {
    const server = new RpcServer();
    await expect(server.listen(await orphaned())).resolves.toBeUndefined();
    await server.close();
  });

  test("refuses a path that is not a socket", async () => {
    const path = endpoint();
    await writeFile(path, "not a socket");
    await expect(new RpcServer().listen(path)).rejects.toThrow("will not replace");
  });

  test("names the live-socket case apart from every other listen failure", async () => {
    const path = endpoint();
    const first = new RpcServer();
    await first.listen(path);
    try {
      await expect(new RpcServer().listen(path)).rejects.toThrow(DaemonAlreadyRunningError);
    } finally {
      await first.close();
    }
  });

  test("keeps the bind while draining so a replacement cannot steal the socket", async () => {
    const path = endpoint();
    const first = new RpcServer();
    await first.listen(path);
    first.drain();
    try {
      await expect(new RpcServer().listen(path)).rejects.toThrow(DaemonAlreadyRunningError);
    } finally {
      await first.close();
    }
    const next = new RpcServer();
    await next.listen(path);
    await next.close();
  });

  test("leaves a replacement's socket in place when the old daemon closes", async () => {
    const path = endpoint();
    const old = new RpcServer();
    await old.listen(path);
    // A replacement that judged the old socket stale unlinked it and bound its own.
    await rm(path);
    const replacement = new RpcServer();
    await replacement.listen(path);
    try {
      await old.close();
      expect((await lstat(path)).isSocket()).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(path, () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
    } finally {
      await replacement.close();
    }
  });
});

/** A connected client that collects every frame the server sends it. */
async function client(
  path: string,
): Promise<{ socket: Socket; frames: unknown[]; closed: Promise<void> }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = connect(path, () => resolve(opened));
    opened.once("error", reject);
  });
  const frames: unknown[] = [];
  let partial = "";
  socket.on("data", (chunk) => {
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line !== "") frames.push(JSON.parse(line));
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return { socket, frames, closed };
}

/** A run event carrying `data` of any size, for the frame limits. */
function huge(data: string): RunEvent {
  return {
    id: 1,
    runId: "run_1",
    occurredAtMs: 0,
    eventType: RunEventType.Phase,
    data,
  } as RunEvent;
}

function send(socket: Socket, message: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function initialize(socket: Socket): void {
  send(socket, {
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      client: { kind: "cli", name: "aireg", version: "0.0.0", instanceId: "test" },
    },
  });
}

describe.skipIf(process.platform === "win32")("rpc server limits", () => {
  afterEach(async () => {
    vi.useRealTimers();
    for (const path of paths.splice(0)) await rm(path, { force: true });
  });

  test("refuses a request past the per-client limit on unanswered ones", async () => {
    const path = endpoint();
    const server = new RpcServer();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.method("initialize", async () => ({}));
    server.method("slow", async () => held.then(() => "done"));
    await server.listen(path);
    const { socket, frames } = await client(path);
    try {
      initialize(socket);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      for (let index = 0; index < 17; index += 1) send(socket, { id: index, method: "slow" });
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]).toMatchObject({
        id: 16,
        error: {
          code: RpcErrorCode.Server,
          message:
            "The aireg daemon is answering too many requests at once. Run the command again.",
        },
      });
      release();
      await vi.waitFor(() => expect(frames).toHaveLength(18));
      // Once answered, the slots are free again.
      send(socket, { id: "again", method: "slow" });
      await vi.waitFor(() => expect(frames).toHaveLength(19));
      expect(frames[18]).toMatchObject({ id: "again", result: "done" });
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  test("closes even when a handler never returns", async () => {
    const path = endpoint();
    const server = new RpcServer();
    server.method("initialize", async () => ({}));
    let stuck = false;
    server.method("stuck", () => {
      stuck = true;
      return new Promise(() => {});
    });
    await server.listen(path);
    const { socket, frames } = await client(path);
    initialize(socket);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    send(socket, { id: 1, method: "stuck" });
    await vi.waitFor(() => expect(stuck).toBe(true));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(closed).toBe(true);
  });

  test("answers a reply too large to frame with an error, and keeps the client", async () => {
    const path = endpoint();
    const server = new RpcServer();
    server.method("initialize", async () => ({}));
    server.method("huge", async () => "x".repeat(2 * 1024 * 1024));
    server.method("small", async () => "ok");
    await server.listen(path);
    const { socket, frames } = await client(path);
    try {
      initialize(socket);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      // Nor is every client dropped for a notification too large to send.
      server.broadcast("run.event", huge("x".repeat(2 * 1024 * 1024)));
      send(socket, { id: 1, method: "huge" });
      send(socket, { id: 2, method: "small" });
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames[1]).toMatchObject({
        id: 1,
        error: {
          code: RpcErrorCode.Internal,
          message: "The aireg daemon's reply is larger than 1 MiB, so it was not sent.",
        },
      });
      expect(frames[2]).toMatchObject({ id: 2, result: "ok" });
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  test("drops a client that never initializes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const path = endpoint();
    const server = new RpcServer();
    await server.listen(path);
    const { socket, closed } = await client(path);
    try {
      // The server sees the connection on its own turn, after the client's.
      await vi.waitFor(() => vi.getTimerCount() > 0 || Promise.reject(new Error("not yet")));
      vi.advanceTimersByTime(10_000);
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("drops a client that stopped reading before it queues much", async () => {
    const path = endpoint();
    const server = new RpcServer();
    server.method("initialize", async () => ({}));
    await server.listen(path);
    const { socket, frames, closed } = await client(path);
    try {
      initialize(socket);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      socket.pause();
      let dropped = false;
      void closed.then(() => {
        dropped = true;
      });
      const message = "x".repeat(900 * 1024);
      // Twelve frames are well under the 16 MiB a reply may queue, and well over
      // what a notification may.
      for (let index = 0; index < 12 && !dropped; index += 1) {
        server.broadcast("run.event", huge(message));
        // One turn of the event loop, so the server sees what the socket has queued.
        await new Promise((settle) => setImmediate(settle));
      }
      socket.resume();
      await closed;
      expect(dropped).toBe(true);
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});
