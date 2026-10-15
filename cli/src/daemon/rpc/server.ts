import { randomUUID } from "node:crypto";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { type Logger, nullLogger } from "#core/log/index.ts";
import { settledWithin } from "#daemon/settled.ts";
import { RpcErrorCode } from "./codes.ts";
import { listening } from "./endpoint.ts";
import { rpcError } from "./errors.ts";
import { FrameDecoder, MAX_RPC_FRAME_BYTES, MAX_RPC_FRAME_SHOWN } from "./frames.ts";
import {
  type DaemonNotification,
  type DaemonNotifications,
  encodeMessage,
  PROTOCOL_VERSION,
  type RpcFailure,
  type RpcId,
  type RpcIncoming,
} from "./protocol.ts";

export interface RpcContext {
  signal: AbortSignal;
}

export type RpcHandler = (params: unknown, context: RpcContext) => Promise<unknown>;
type Sender = (message: Parameters<typeof encodeMessage>[0]) => boolean;
const MAX_CLIENTS = 32;
const MAX_REQUESTS_PER_SECOND = 200;
/**
 * A rate alone lets a client keep thousands of slow requests running, each
 * holding a full scan, so how many may be unanswered at once is capped too.
 */
const MAX_INFLIGHT_PER_CLIENT = 16;
/** A client that connects and never says who it is would hold a slot for good. */
const INITIALIZE_WITHIN_MS = 10_000;
/** How long closing waits for handlers still running before it goes anyway. */
const CLOSE_GRACE_MS = 15_000;
const MAX_CLIENT_FIELD_LENGTH = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;

interface ClientState {
  initialized: boolean;
}

function validClient(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== "cli") return false;
  return [value.name, value.version, value.instanceId].every(
    (field) =>
      typeof field === "string" &&
      field.trim() !== "" &&
      field.length <= MAX_CLIENT_FIELD_LENGTH &&
      !CONTROL_CHARACTER.test(field),
  );
}

function failure(
  id: RpcId | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): RpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/**
 * Unread reply a client may hold before it is dropped. Paged run events queue faster than a
 * host relays them, so this is well above one frame; each frame still has the frame limit.
 */
const MAX_QUEUED_BYTES = 16 * MAX_RPC_FRAME_BYTES;
/**
 * Notifications go to every client whether or not it asked, so one that has
 * stopped reading, such as a suspended `aireg job runs --follow`, is dropped sooner.
 */
const MAX_QUEUED_NOTIFICATION_BYTES = 4 * MAX_RPC_FRAME_BYTES;

function sendFrame(socket: Socket, frame: string, queued = MAX_QUEUED_BYTES): boolean {
  if (
    socket.destroyed ||
    Buffer.byteLength(frame) > MAX_RPC_FRAME_BYTES ||
    socket.writableLength > queued
  ) {
    socket.destroy();
    return false;
  }
  socket.write(frame);
  return true;
}

/** Separates a socket another daemon answers on from every other reason listening failed. */
export class DaemonAlreadyRunningError extends AiregError {
  constructor() {
    super("The aireg daemon is already running.", { code: ErrorCode.Busy });
    this.name = "DaemonAlreadyRunningError";
  }
}

async function removeStale(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(endpoint);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isSocket())
    throw new Error(`The daemon will not replace ${endpoint}, because it is not a socket.`);
  if (await listening(endpoint)) throw new DaemonAlreadyRunningError();
  await unlink(endpoint);
}

function bind(path: string, accept: (socket: Socket) => void): Promise<Server> {
  const server = createServer(accept);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** A replacement may have unlinked this path and bound its own socket there. */
async function unlinkOwn(endpoint: string, bound: { dev: number; ino: number }): Promise<void> {
  try {
    const { dev, ino } = await lstat(endpoint);
    if (dev !== bound.dev || ino !== bound.ino) return;
    await unlink(endpoint);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export class RpcServer {
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #clients = new Map<Socket, ClientState>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #log: Logger;
  #server: Server | undefined;
  #endpoint: string | undefined;
  /** The socket file this server bound, so close never removes a successor's. */
  #bound: { dev: number; ino: number } | undefined;
  #draining = false;

  constructor(log: Logger = nullLogger()) {
    this.#log = log;
  }

  method(name: string, handler: RpcHandler): void {
    if (this.#handlers.has(name))
      throw new Error(`JSON-RPC method "${name}" is already registered.`);
    this.#handlers.set(name, handler);
  }

  async listen(endpoint: string): Promise<void> {
    if (this.#server !== undefined) throw new Error("The JSON-RPC server is already listening.");
    await removeStale(endpoint);
    if (process.platform === "win32") {
      // A named pipe in use is one another daemon answers on; there is no file to check first.
      try {
        this.#server = await bind(endpoint, (socket) => this.#accept(socket));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new DaemonAlreadyRunningError();
        }
        throw error;
      }
      this.#endpoint = endpoint;
      return;
    }
    // Closing unlinks the bound path whoever holds it by then, so binding a private name and
    // linking it into place means a stopping daemon never removes a successor's socket.
    const staging = join(dirname(endpoint), `.rpc-${randomUUID().slice(0, 8)}.sock`);
    const server = await bind(staging, (socket) => this.#accept(socket));
    try {
      await chmod(staging, PRIVATE_FILE);
      await link(staging, endpoint);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DaemonAlreadyRunningError();
      throw error;
    } finally {
      await unlink(staging).catch(() => undefined);
    }
    const { dev, ino } = await lstat(endpoint);
    this.#server = server;
    this.#endpoint = endpoint;
    this.#bound = { dev, ino };
  }

  /**
   * Drop clients but keep the bind so a replacement cannot listen yet. A new
   * client can still initialize, which is how it learns the daemon is stopping.
   */
  drain(): void {
    this.#draining = true;
    for (const client of [...this.#clients.keys()]) client.destroy();
  }

  #accept(socket: Socket): void {
    if (this.#clients.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder("a client");
    const controller = new AbortController();
    const state: ClientState = { initialized: false };
    let requestWindow = Date.now();
    let requestCount = 0;
    let unanswered = 0;
    this.#clients.set(socket, state);
    socket.setNoDelay(true);
    const unidentified = setTimeout(() => {
      if (!state.initialized) socket.destroy();
    }, INITIALIZE_WITHIN_MS);
    unidentified.unref();

    const send = (message: Parameters<typeof encodeMessage>[0]): boolean => {
      const frame = encodeMessage(message);
      if (Buffer.byteLength(frame) <= MAX_RPC_FRAME_BYTES) return sendFrame(socket, frame);
      // Sent as it is, a frame past the limit would drop the client with no word
      // of why: a reply says so instead, and a notification is left out.
      const method = "method" in message ? message.method : undefined;
      this.#log.warn("left out a message larger than the frame limit", { method });
      if (!("id" in message)) return false;
      return sendFrame(
        socket,
        encodeMessage(
          failure(
            message.id,
            RpcErrorCode.Internal,
            `The aireg daemon's reply is larger than ${MAX_RPC_FRAME_SHOWN}, so it was not sent.`,
          ),
        ),
      );
    };
    // Past the rate the client is dropped; past the unanswered limit only the request is refused.
    const admitted = (message: RpcIncoming): boolean => {
      const now = Date.now();
      if (now - requestWindow >= 1000) {
        requestWindow = now;
        requestCount = 0;
      }
      requestCount += 1;
      if (requestCount > MAX_REQUESTS_PER_SECOND)
        throw new Error("The client sent too many requests per second.");
      if (unanswered < MAX_INFLIGHT_PER_CLIENT) return true;
      if ("id" in message)
        send(
          failure(
            message.id,
            RpcErrorCode.Server,
            "The aireg daemon is answering too many requests at once. Run the command again.",
          ),
        );
      return false;
    };
    socket.on("data", (chunk) => {
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        for (const message of decoder.push(bytes)) {
          if (!("result" in message) && !("error" in message) && admitted(message)) {
            unanswered += 1;
            const pending = this.#dispatch(message, state, controller.signal, send);
            this.#inflight.add(pending);
            void pending
              .finally(() => {
                unanswered -= 1;
                this.#inflight.delete(pending);
              })
              .catch((error: unknown) => {
                this.#log.warn("dropping a client whose request could not be dispatched", {
                  method: "method" in message ? message.method : undefined,
                  error,
                });
                socket.destroy();
              });
          }
        }
      } catch (error) {
        // The client is dropped with no reply, so this is the only record that
        // it was refused rather than lost.
        this.#log.warn("dropping a client after a bad frame or rate limit", { error });
        socket.destroy();
      }
    });
    socket.once("close", () => {
      clearTimeout(unidentified);
      controller.abort();
      this.#clients.delete(socket);
      try {
        decoder.end();
      } catch {
        socket.destroy();
      }
    });
    socket.once("error", () => socket.destroy());
  }

  #ready(message: RpcIncoming, state: ClientState, send: Sender): boolean {
    const requestId = "id" in message ? message.id : undefined;
    if (!state.initialized && message.method !== "initialize") {
      if (requestId !== undefined)
        send(failure(requestId, RpcErrorCode.NotInitialized, "Call initialize first."));
      return false;
    }
    if (state.initialized && message.method === "initialize") {
      if (requestId !== undefined)
        send(
          failure(requestId, RpcErrorCode.InvalidRequest, "This client is already initialized."),
        );
      return false;
    }
    if (message.method !== "initialize") return true;
    const params = message.params as { protocolVersion?: unknown; client?: unknown } | undefined;
    if (params?.protocolVersion !== PROTOCOL_VERSION) {
      if (requestId !== undefined)
        send(
          failure(
            requestId,
            RpcErrorCode.UnsupportedVersion,
            `Only protocol version ${PROTOCOL_VERSION} is supported.`,
          ),
        );
      return false;
    }
    if (!validClient(params?.client)) {
      if (requestId !== undefined)
        send(failure(requestId, RpcErrorCode.InvalidParams, "The client identity is not valid."));
      return false;
    }
    state.initialized = true;
    return true;
  }

  async #dispatch(
    message: RpcIncoming,
    state: ClientState,
    signal: AbortSignal,
    send: Sender,
  ): Promise<void> {
    if (!this.#ready(message, state, send)) return;
    const requestId = "id" in message ? message.id : undefined;
    if (this.#draining && message.method !== "initialize") {
      if (requestId !== undefined)
        send(failure(requestId, RpcErrorCode.Server, "The aireg daemon is stopping."));
      return;
    }
    const handler = this.#handlers.get(message.method);
    if (handler === undefined) {
      if (requestId !== undefined)
        send(
          failure(
            requestId,
            RpcErrorCode.MethodNotFound,
            `No method named ${quoted(message.method)}.`,
          ),
        );
      return;
    }
    try {
      const result = await handler(message.params ?? {}, { signal });
      if (requestId !== undefined) send({ jsonrpc: "2.0", id: requestId, result });
    } catch (error) {
      const mapped = rpcError(error);
      // An unmapped failure reaches the caller as "internal error", so unless
      // the cause is recorded here it is gone.
      if (mapped.code === RpcErrorCode.Internal) {
        this.#log.error("method failed", { method: message.method, error });
      }
      if (requestId === undefined) return;
      send(failure(requestId, mapped.code, mapped.message, mapped.data));
    }
  }

  broadcast<M extends DaemonNotification>(method: M, params: DaemonNotifications[M]): void {
    const frame = encodeMessage({ jsonrpc: "2.0", method, params });
    // Past the limit it would drop every client at once.
    if (Buffer.byteLength(frame) > MAX_RPC_FRAME_BYTES) {
      this.#log.warn("left out a notification larger than the frame limit", { method });
      return;
    }
    for (const [client, state] of this.#clients) {
      if (state.initialized) sendFrame(client, frame, MAX_QUEUED_NOTIFICATION_BYTES);
    }
  }

  async close(): Promise<void> {
    for (const client of this.#clients.keys()) client.destroy();
    if (this.#server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        this.#server?.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    // A handler stuck on a wait it cannot leave would otherwise keep the daemon
    // from ever stopping, and so from ever being replaced.
    await settledWithin(this.#inflight, CLOSE_GRACE_MS);
    if (this.#endpoint !== undefined && this.#bound !== undefined) {
      await unlinkOwn(this.#endpoint, this.#bound);
    }
    this.#server = undefined;
    this.#endpoint = undefined;
    this.#bound = undefined;
    this.#draining = false;
  }
}
