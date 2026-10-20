import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { plural } from "#adapter/text.ts";
import type { RegistryConfig } from "#core/config/model.ts";
import { isRecord } from "#core/fields.ts";
import { NAME } from "#core/product.ts";
import { isTerminal, type RunEvent } from "#core/run/model.ts";
import { RpcErrorCode } from "./codes.ts";
import { assertOwnSocket } from "./endpoint.ts";
import { FrameDecoder } from "./frames.ts";
import {
  type ClientInfo,
  type DaemonMethod,
  type DaemonMethods,
  type DaemonNotification,
  type DaemonNotifications,
  encodeMessage,
  MAX_PAGE_SIZE,
  PROTOCOL_VERSION,
  type RpcId,
  type RpcResponse,
} from "./protocol.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class RpcClientError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
    this.data = data;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

function waited(ms: number): string {
  return ms < 1_000 ? plural(ms, "millisecond") : plural(Math.round(ms / 1_000), "second");
}

function compatibleHandshake(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.daemon)) return false;
  const { daemon } = value;
  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    typeof daemon.instanceId === "string" &&
    Number.isSafeInteger(daemon.startedAtMs) &&
    Number.isSafeInteger(daemon.serverNowMs)
  );
}

/** The daemon's package version, which can differ while the protocol version matches. */
function handshakeVersion(value: unknown): string | undefined {
  if (!compatibleHandshake(value)) return undefined;
  const server = (value as Record<string, unknown>).server;
  if (!isRecord(server) || server.name !== NAME) return undefined;
  return typeof server.version === "string" && server.version !== "" ? server.version : undefined;
}

export function cliClient(version: string): ClientInfo {
  return {
    kind: "cli",
    name: `${NAME}-cli`,
    version,
    instanceId: `cli_${randomUUID()}`,
  };
}

export class RpcClient {
  readonly #socket: Socket;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #listeners = new Set<
    <M extends DaemonNotification>(method: M, params: DaemonNotifications[M]) => void
  >();
  readonly #closeListeners = new Set<(error: Error) => void>();
  #nextId = 1;
  #failed = false;
  #serverVersion = "";
  #stopping = false;

  get serverVersion(): string {
    return this.#serverVersion;
  }

  /** The daemon is finishing its runs on the way out, and answers nothing else. */
  get stopping(): boolean {
    return this.#stopping;
  }

  private constructor(socket: Socket) {
    this.#socket = socket;
    const decoder = new FrameDecoder("the aireg daemon");
    socket.on("data", (chunk) => {
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        for (const message of decoder.push(bytes)) {
          if ("method" in message && !("id" in message)) {
            for (const listener of this.#listeners) {
              listener(message.method as DaemonNotification, message.params as never);
            }
          } else if ("result" in message || "error" in message) {
            this.#settle(message);
          }
        }
      } catch (error) {
        this.#fail(error as Error);
      }
    });
    // `on`, not `once`: a dropped socket can report a second error, such as a write's EPIPE.
    socket.on("error", (error) => this.#fail(error));
    socket.once("close", () => this.#fail(new Error(CLOSED)));
  }

  /** A daemon at its client limit drops new connections, so those wait for a slot. */
  static async connect(endpoint: string, clientInfo: ClientInfo): Promise<RpcClient> {
    const deadline = Date.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        return await RpcClient.#connectOnce(endpoint, clientInfo);
      } catch (error) {
        if (!dropped(error) || Date.now() >= deadline) throw error;
        await new Promise((wake) => setTimeout(wake, 20 + Math.random() * 80));
      }
    }
  }

  static async #connectOnce(endpoint: string, clientInfo: ClientInfo): Promise<RpcClient> {
    await assertOwnSocket(endpoint);
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off("error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        socket.off("connect", connected);
        reject(error);
      };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
    const client = new RpcClient(socket);
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        client: clientInfo,
      });
      const version = handshakeVersion(initialized);
      if (version === undefined) {
        throw new RpcClientError(
          RpcErrorCode.UnsupportedVersion,
          "The running aireg daemon is incompatible with this CLI. Run `aireg daemon restart`.",
        );
      }
      client.#serverVersion = version;
      client.#stopping = initialized.daemon.stopping === true;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  #settle(response: RpcResponse): void {
    if (response.id === null) return;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if ("error" in response) {
      pending.reject(
        new RpcClientError(response.error.code, response.error.message, response.error.data),
      );
    } else pending.resolve(response.result);
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
    this.#socket.destroy();
  }

  request<M extends DaemonMethod>(
    method: M,
    params: DaemonMethods[M]["params"],
    options: { timeoutMs?: number } = {},
  ): Promise<DaemonMethods[M]["result"]> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `The aireg daemon did not answer within ${waited(timeout)}. ` +
              "Run `aireg daemon status` to check on it.",
          ),
        );
      }, timeout);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#socket.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  onNotification(
    listener: <M extends DaemonNotification>(method: M, params: DaemonNotifications[M]) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#socket.destroy();
  }
}

const CLOSED = "The aireg daemon closed the connection.";

/** How long a command waits for a daemon serving as many clients as it allows. */
const BUSY_WAIT_MS = 5_000;

/** Closed before the handshake finished: what a daemon at its client limit does. */
function dropped(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return message === CLOSED || code === "ECONNRESET" || code === "EPIPE" || code === "ENOTCONN";
}

/** How many times a write is redone after another writer moved the config first. */
const STALE_RETRIES = 30;

/**
 * A config write made against a fresh snapshot, redone while another writer
 * keeps moving the revision first, so parallel commands both land.
 */
export async function withFreshConfig<T>(
  client: RpcClient,
  write: (config: RegistryConfig) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const { config } = await client.request("state.snapshot", {});
    try {
      return await write(config);
    } catch (error) {
      const stale = error instanceof RpcClientError && error.code === RpcErrorCode.StaleRevision;
      if (!stale || attempt >= STALE_RETRIES) throw error;
      // Jittered, so writers that collided once do not collide again in step.
      await new Promise((wake) => setTimeout(wake, 10 + Math.random() * 40));
    }
  }
}

/** Every event of a run after `afterEventId`, fetched a page at a time. */
export async function* runEvents(
  client: RpcClient,
  runId: string,
  afterEventId?: number,
): AsyncGenerator<RunEvent> {
  let after = afterEventId;
  for (;;) {
    const page = await client.request("run.events", {
      runId,
      ...(after === undefined ? {} : { afterEventId: after }),
      limit: MAX_PAGE_SIZE,
    });
    yield* page.events;
    if (!page.hasMore) return;
    after = page.events.at(-1)?.id;
  }
}

/**
 * Every event of one run, in order and each once: what the store holds, then the
 * daemon's broadcasts, until the run finishes. Rejects if the connection closes first.
 */
export async function followRun(
  client: RpcClient,
  runId: string,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  // Event ids only go up, so the newest shown is all that skipping repeats needs.
  let shown = 0;
  let catchingUp = true;
  let finishedSeen = false;
  const live: RunEvent[] = [];
  let resolveFinished: () => void = () => {};
  let rejectFinished: (error: Error) => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  void finished.catch(() => {});
  const show = (event: RunEvent) => {
    if (event.id <= shown) return;
    shown = event.id;
    onEvent(event);
    if (event.eventType === "run.finished") {
      finishedSeen = true;
      resolveFinished();
    }
  };
  const stopNotifications = client.onNotification((method, params) => {
    if (method !== "run.event") return;
    const event = params as RunEvent;
    if (event.runId !== runId) return;
    if (catchingUp) live.push(event);
    else show(event);
  });
  const stopClose = client.onClose((error) => rejectFinished(error));
  try {
    for await (const event of runEvents(client, runId)) show(event);
    catchingUp = false;
    for (const event of live.sort((left, right) => left.id - right.id)) show(event);
    if (finishedSeen) return;
    const { run } = await client.request("run.get", { runId });
    if (!isTerminal(run.state)) await finished;
  } finally {
    stopNotifications();
    stopClose();
  }
}
