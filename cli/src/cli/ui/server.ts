import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";
import { messageOf } from "#adapter/errors.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { configPath } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { roots, scopeFor, stateDir } from "#core/store/paths.ts";
import { Catalogs } from "./catalogs.ts";
import { Events } from "./events.ts";
import {
  type Bound,
  cookieName,
  EVENTS_PATH,
  HEALTH_PATH,
  instanceId,
  RPC_PATH,
  refusal,
  SESSION_PATH,
  same,
  sessionValue,
} from "./guard.ts";
import { Operations } from "./operations.ts";
import { PageReader } from "./page-state.ts";
import { dispatch } from "./rpc.ts";

interface Asset {
  type: string;
  body: Buffer;
  /** Named by its content hash, so a browser may keep it for good. */
  immutable: boolean;
}

export interface ServeOptions {
  context: CommandContext;
  /** 0 lets the system choose a free one. */
  port: number;
  /** The page, by the path it is served at. */
  assets: Readonly<Record<string, Asset>>;
}

export interface Serving {
  port: number;
  /** Minted per launch; the launch address carries it after `#`. */
  token: string;
  close(): Promise<void>;
}

const LARGEST_BODY = 64 * 1024;
/**
 * A refused body is read and dropped up to this much before the connection closes: closing with
 * it unread resets the connection, and the client may lose the answer.
 */
const DROPPED_BODY = 4 * 1024 * 1024;

/** Scripts and styles only from this server's own files, and never framed. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

interface Server {
  bound: Bound;
  assets: Readonly<Record<string, Asset>>;
  reader: PageReader;
  operations: Operations;
  events: Events;
}

export async function serve(options: ServeOptions): Promise<Serving> {
  const token = randomBytes(32).toString("base64url");
  const catalogs = new Catalogs(options.context);
  const reader = new PageReader(options.context, catalogs);
  const events = new Events(reader);
  catalogs.onRead = () => events.changed();
  const operations = new Operations(
    reader,
    (event) => events.emit(event),
    () => events.changed(true),
  );
  let server: Server | undefined;
  const http = createServer((request, response) => {
    if (server === undefined) return send(response, 503, { error: "The server is starting." });
    answer(request, response, server).catch((error: unknown) => {
      // The terminal gets the detail; the page gets a sentence that names no path.
      console.error(`aireg ui: ${messageOf(error)}`);
      if (!response.headersSent) send(response, 500, { error: "That did not work." });
      else response.end();
    });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await listen(http, options.port);
  const port = (http.address() as AddressInfo).port;
  server = { bound: { port, token }, assets: options.assets, reader, operations, events };
  void watchState(reader, events);
  return {
    port,
    token,
    close: async () => {
      events.close();
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      // Its children hold leases; the process must not exit before they do.
      await Promise.all([operations.close(), closed]);
    },
  };
}

function listen(http: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new AiregError(`Port ${port} on 127.0.0.1 is already in use.`, {
              code: ErrorCode.Unavailable,
              hint: "Choose another with `--port`, or leave it out for a free one.",
            })
          : error,
      ),
    );
    http.listen(port, "127.0.0.1", () => resolve());
  });
}

/** The lockfile and manifest of the scope shown, aireg's config, and its run store. */
async function watchState(reader: PageReader, events: Events): Promise<void> {
  try {
    const { root } = await reader.read();
    const scope = roots(scopeFor(root), root);
    // The home folder also holds credentials and caches that reads rewrite.
    const files = new Map<string, string[]>();
    for (const file of [scope.lock, scope.manifest, configPath()]) {
      files.set(dirname(file), [...(files.get(dirname(file)) ?? []), basename(file)]);
    }
    events.watch([
      ...[...files].map(([folder, names]) => ({ folder, names })),
      { folder: stateDir() },
    ]);
  } catch (error) {
    console.error(`aireg ui: live updates are off: ${messageOf(error)}`);
  }
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const path = url.pathname;
  const refused = refusal({ method, path, headers: request.headers }, server.bound);
  if (refused !== undefined) return reject(request, response, refused.status, refused.message);
  if (path === HEALTH_PATH) {
    return send(response, 200, { ok: true, instance: instanceId(server.bound.token) });
  }
  if (path === EVENTS_PATH) {
    if (!server.events.attach(response, HEADERS)) {
      send(response, 429, { error: "Too many pages are open." });
    }
    return;
  }
  if (path === SESSION_PATH || path === RPC_PATH) {
    const body = await read(request);
    if (body === undefined) return reject(request, response, 413, "The request is too large.");
    if (path === RPC_PATH) return send(response, 200, await dispatch(body, server));
    return session(response, body, server.bound);
  }
  sendAsset(response, path, server.assets);
}

/** The launch token, sent once, buys a cookie no script can read. */
function session(response: ServerResponse, body: string, bound: Bound): void {
  let given: unknown;
  try {
    given = (JSON.parse(body) as { token?: unknown }).token;
  } catch {
    given = undefined;
  }
  if (typeof given !== "string" || !same(given, bound.token)) {
    send(response, 401, { error: "That launch address is not this server's." });
    return;
  }
  const cookie = `${cookieName(bound.port)}=${sessionValue(bound.token)}; HttpOnly; SameSite=Strict; Path=/`;
  response.writeHead(204, { ...HEADERS, "set-cookie": cookie });
  response.end();
}

/** Undefined past the limit, with the rest read and dropped unless it is too large even to drop. */
async function read(request: IncomingMessage): Promise<string | undefined> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > LARGEST_BODY) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > DROPPED_BODY) return undefined;
    if (size <= LARGEST_BODY) chunks.push(chunk);
  }
  return size > LARGEST_BODY ? undefined : Buffer.concat(chunks).toString("utf8");
}

/** Answers once the body is read and dropped, then closes, so no leftover is parsed as a request. */
function reject(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
): void {
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    response.writeHead(status, {
      ...HEADERS,
      "content-type": "application/json; charset=utf-8",
      connection: "close",
    });
    response.end(JSON.stringify({ error: message }), () => request.destroy());
  };
  if (request.complete || request.destroyed) {
    answer();
    return;
  }
  let dropped = 0;
  request.on("data", (chunk: Buffer) => {
    dropped += chunk.length;
    if (dropped > DROPPED_BODY) answer();
  });
  request.once("end", answer);
  request.once("error", answer);
}

function sendAsset(
  response: ServerResponse,
  path: string,
  assets: Readonly<Record<string, Asset>>,
): void {
  // Any other path outside `/assets/` is one of the page's own routes.
  const fallback = path.startsWith("/assets/") ? undefined : assets["/"];
  const asset = Object.hasOwn(assets, path) ? assets[path] : fallback;
  if (asset === undefined) {
    response.writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }
  response.writeHead(200, {
    ...HEADERS,
    "content-type": asset.type,
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(asset.body);
}

function send(response: ServerResponse, status: number, document: object): void {
  response.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(document));
}
