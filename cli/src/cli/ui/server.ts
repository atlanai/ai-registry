import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { messageOf } from "#adapter/errors.ts";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { Catalogs } from "#cli/catalog/registries.ts";
import { CatalogReader, type CatalogState, type KeptArtifact } from "#cli/catalog/state.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { underHome } from "#cli/render/home.ts";
import * as commands from "#core/console/actions.ts";
import { Discovery } from "#core/discovery/service.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { scoreSkill } from "#core/score/skill.ts";
import * as uiCommands from "./actions.ts";
import { type Ran, run } from "./child.ts";
import { discoveryRoute } from "./discovery.ts";
import { API_PREFIX, type Bound, refusal } from "./guard.ts";

export interface Asset {
  type: string;
  body: string;
}

export interface ServeOptions {
  context: CommandContext;
  /** 0 lets the system choose a free one. */
  port: number;
  /** The page, by the path it is served at. */
  assets: Readonly<Record<string, Asset>>;
}

export interface Serving {
  /** Carries the token after `#`, which a browser never sends to a server. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const LARGEST_BODY = 64 * 1024;
/** A name the page sends: one path segment, so `..` or `/` never reaches the disk. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Scripts and styles only from this server's own files, and never framed. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
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
  discovery: Discovery;
  reader: CatalogReader;
  context: CommandContext;
  assets: Readonly<Record<string, Asset>>;
  /** True while a write runs: one at a time, as the lease allows anyway. */
  busy: boolean;
  /** `aireg show` children reading a file a registry serves; a few at a time. */
  showing: number;
}

export async function serve(options: ServeOptions): Promise<Serving> {
  const token = randomBytes(32).toString("base64url");
  const server: Server = {
    discovery: new Discovery(),
    reader: new CatalogReader(options.context, new Catalogs(options.context)),
    context: options.context,
    assets: options.assets,
    busy: false,
    showing: 0,
  };
  let bound: Bound | undefined;
  const http = createServer((request, response) => {
    if (bound === undefined)
      return send(response, 503, { ok: false, error: "The server is starting." });
    answer(request, response, bound, server).catch((error: unknown) => {
      // The terminal gets the detail; the page gets a sentence that names no path.
      console.error(`aireg ui: ${messageOf(error)}`);
      if (!response.headersSent) send(response, 500, { ok: false, error: "That did not work." });
    });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new AiregError(`Port ${options.port} on 127.0.0.1 is already in use.`, {
              code: ErrorCode.Unavailable,
              hint: "Choose another with `--port`, or leave it out for a free one.",
            })
          : error,
      ),
    );
    http.listen(options.port, "127.0.0.1", () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  bound = { port, token };
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.discovery.stop();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

type Route = (request: IncomingMessage, url: URL, server: Server) => Promise<[number, object]>;

const ROUTES: Readonly<Record<string, Route>> = {
  "GET /api/discovery": (_request, _url, server) =>
    discoveryRoute(server.discovery, server.context, "status", {}),
  "POST /api/discovery": async (request, _url, server) => {
    const payload = await body(request);
    return discoveryRoute(server.discovery, server.context, String(payload.action), payload);
  },
  "GET /api/artifacts": async (_request, url, server) => [
    200,
    artifactsOf(await server.reader.read(url.searchParams.get("fresh") === "1")),
  ],
  "GET /api/skill": (_request, url, server) => fileOf(url.searchParams.get("key"), server),
  "GET /api/console": async (_request, _url, server) => [
    200,
    { ok: true, data: consoleOf(await server.reader.read()) },
  ],
  // Read-only, so it takes no write gate; it runs the same CLI as every action.
  "GET /api/doctor": async (_request, _url, server) => {
    const ran = await run(uiCommands.doctor(), (await server.reader.read()).root);
    return [200, ran.json ?? { ok: false, error: "aireg doctor printed nothing." }];
  },
  "POST /api/sync": async (_request, _url, server) => {
    const state = await server.reader.read();
    return write(server, commands.pullLatest(undefined, state.console.scope), (ran) => ({
      ok: ran.code === 0,
      message: ran.lines.join("\n"),
    }));
  },
  "POST /api/add": async (request, _url, server) => addFrom(await body(request), server),
  "POST /api/retire": async (request, _url, server) => retire(await body(request), server),
};

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  bound: Bound,
  server: Server,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const refused = refusal({ method, path: url.pathname, headers: request.headers }, bound);
  if (refused !== undefined) {
    request.resume();
    return send(response, refused.status, { ok: false, error: refused.message });
  }
  if (!url.pathname.startsWith(API_PREFIX)) return sendAsset(response, url.pathname, server.assets);
  const route = ROUTES[`${method} ${url.pathname}`];
  if (route === undefined) {
    request.resume();
    return send(response, 404, { ok: false, error: "There is nothing at that address." });
  }
  try {
    const [status, document] = await route(request, url, server);
    send(response, status, document);
  } catch (error) {
    if (!(error instanceof PageError)) throw error;
    send(response, error.status, {
      ok: false,
      error: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
}

class PageError extends Error {
  readonly status: number;
  readonly hint: string | undefined;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/** What the page lists: everything but where each row is on disk. */
function artifactsOf(state: CatalogState): object {
  const namespaces: Record<string, number> = {};
  const harnesses: Record<string, number> = {};
  for (const artifact of state.artifacts) {
    const group = artifact.namespace === "" ? artifact.registry : artifact.namespace;
    namespaces[group] = (namespaces[group] ?? 0) + 1;
    for (const target of artifact.harnesses) harnesses[target] = (harnesses[target] ?? 0) + 1;
  }
  return {
    ok: true,
    data: {
      total: state.artifacts.length,
      artifacts: state.artifacts.map(({ copy: _copy, installedKey, local: _local, ...shown }) => ({
        ...shown,
        removable: installedKey !== undefined,
      })),
      stats: { total: state.artifacts.length, namespaces, harnesses },
      registries: state.registries,
      problems: state.problems,
      readAtMs: state.readAtMs,
    },
  };
}

function consoleOf(state: CatalogState): object {
  return {
    ...state.console,
    groups: state.console.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({ ...row, copy: row.copy === "" ? "" : underHome(row.copy) })),
    })),
  };
}

async function find(key: unknown, server: Server, fresh = false): Promise<KeptArtifact> {
  if (typeof key !== "string" || key === "" || key.length > 512)
    throw new PageError(400, "Name one artifact.");
  const artifact = (await server.reader.read(fresh)).artifacts.find(
    (candidate) => candidate.key === key,
  );
  if (artifact === undefined) throw new PageError(404, "No artifact by that name.");
  return artifact;
}

/** The installed copy, read without following a link; else what its registry serves. */
async function fileOf(key: string | null, server: Server): Promise<[number, object]> {
  const artifact = await find(key, server);
  const shown = (path: string, markdown: string): [number, object] => [
    200,
    {
      ok: true,
      data: {
        name: artifact.name,
        namespace: artifact.namespace,
        registry: artifact.registry,
        path,
        markdown,
        score: artifact.kind === "skill" ? scoreSkill(markdown) : null,
      },
    },
  ];
  if (artifact.copy !== "") {
    const [root, file] =
      artifact.kind === "agent"
        ? [dirname(artifact.copy), basename(artifact.copy)]
        : [artifact.copy, artifact.kind === "skill" ? SKILL_ENTRY : "README.md"];
    const read = await readRegular(root, file).catch(() => undefined);
    if (read?.kind === "file")
      return shown(underHome(join(root, file)), read.bytes.toString("utf8"));
  }
  // A plugin may hold no README; that is an answer, not an error.
  if (!artifact.listed) return shown("", "");
  if (server.showing >= 4)
    throw new PageError(429, "Reading too many files at once.", "Try again in a moment.");
  server.showing += 1;
  const ran = await run(
    { display: "", argv: ["show", "--json", "--", artifact.key] },
    server.context.cwd,
  ).finally(() => {
    server.showing -= 1;
  });
  const served = ran.json?.data as { body?: unknown } | undefined;
  if (typeof served?.body !== "string") return shown("", "");
  return shown(`${artifact.key}, as ${artifact.registry} serves it`, served.body);
}

/** One write at a time; a second is refused rather than queued behind the first. */
async function exclusive<T>(server: Server, work: () => Promise<T>): Promise<T> {
  if (server.busy)
    throw new PageError(409, "Another action is still running.", "Wait for it to finish.");
  server.busy = true;
  try {
    return await work();
  } finally {
    server.busy = false;
  }
}

async function write(
  server: Server,
  command: commands.Command,
  reply: (ran: Ran) => object,
): Promise<[number, object]> {
  return exclusive(server, async () => {
    const state = await server.reader.read();
    const ran = await run(command, state.root);
    await server.reader.read(true);
    return [200, reply(ran)];
  });
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > LARGEST_BODY) {
    request.resume();
    throw new PageError(413, "The request is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > LARGEST_BODY) throw new PageError(413, "The request is too large.");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PageError(400, "The request is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PageError(400, "The request is not one the page sends.");
  }
  return parsed as Record<string, unknown>;
}

/** One printable line, bounded; anything else is not an address or a name. */
function line(value: unknown, longest = 2048): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > longest) return undefined;
  for (let at = 0; at < trimmed.length; at++) {
    const code = trimmed.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

function names(value: unknown): string[] {
  const listed = Array.isArray(value) ? value : String(value ?? "").split(",");
  const found = listed.map((item) => String(item).trim()).filter((item) => item !== "");
  if (found.length > 100) throw new PageError(400, "Name at most 100 at a time.");
  if (found.some((item) => !SAFE_NAME.test(item))) {
    throw new PageError(400, "Each name is letters, digits, dots, dashes or underscores.");
  }
  return found;
}

interface Planned {
  installed?: string[];
}

function checkedSource(value: unknown): string {
  const source = line(value);
  if (source === undefined || source.startsWith("-"))
    throw new PageError(400, "Give a source address or repository.");
  // A token in a URL would sit in the process list and in this page.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(source)) {
    throw new PageError(
      400,
      "Give the address without a user name or token.",
      "Sign in with `aireg auth login` instead.",
    );
  }
  return source;
}

function planOf(ran: Ran): Planned {
  return (ran.json?.data as Planned | undefined) ?? {};
}

async function addFrom(
  payload: Record<string, unknown>,
  server: Server,
): Promise<[number, object]> {
  const source = checkedSource(payload.source);
  const dryRun = payload.dryRun === true;
  const select = names(payload.select);
  const trust = payload.trust === true ? names(payload.trustName) : [];
  if (payload.trust === true && trust.length === 0)
    throw new PageError(400, "Name the plugins you chose to trust.");
  const state = await server.reader.read();
  if (dryRun) {
    return write(
      server,
      uiCommands.add(source, { select, trust, dryRun: true, json: false }, state.console.scope),
      (ran) => ({
        ok: ran.code === 0,
        dryRun: true,
        source,
        output: ran.lines.join("\n") || "Nothing would change.",
      }),
    );
  }
  return exclusive(server, async () => {
    const ran = await run(
      uiCommands.add(source, { select, trust, dryRun: false, json: true }, state.console.scope),
      state.root,
    );
    await server.reader.read(true);
    const installed = planOf(ran).installed ?? [];
    const said = [
      ...(installed.length > 0 ? [`Installed ${installed.join(", ")}.`] : []),
      ...(ran.json?.error?.message === undefined
        ? []
        : [ran.json.error.message, ran.json.error.hint ?? ""]),
      ...ran.lines,
    ].filter((text) => text !== "");
    const output = said.length === 0 ? "Nothing changed." : said.join("\n");
    return [
      200,
      {
        ok: ran.code === 0,
        dryRun: false,
        source,
        installed,
        output,
        error: ran.code === 0 ? null : output,
      },
    ];
  });
}

/** Remove only artifacts the existing CLI manages. */
async function retire(payload: Record<string, unknown>, server: Server): Promise<[number, object]> {
  const artifact = await find(payload.key, server, true);
  const dryRun = payload.dryRun === true;
  if (artifact.carriedBy !== undefined) {
    throw new PageError(
      400,
      `${artifact.name} comes with the plugin ${artifact.carriedBy}.`,
      `Remove ${artifact.carriedBy} to remove it.`,
    );
  }
  if (artifact.state === "available")
    throw new PageError(400, `${artifact.name} is not installed here.`);
  const where = artifact.harnesses.join(", ") || "every target";
  if (artifact.installedKey !== undefined) {
    const scope = (await server.reader.read()).console.scope;
    const command = uiCommands.remove([artifact.installedKey], scope, dryRun);
    return write(server, command, (ran) => ({
      ok: ran.code === 0,
      dryRun,
      name: artifact.name,
      targets: artifact.harnesses,
      action: "remove",
      recovery: "The registry copy is unchanged.",
      message:
        ran.code === 0
          ? `${dryRun ? "Would remove" : "Removed"} ${artifact.name} from ${where}.`
          : ran.lines.join("\n"),
    }));
  }
  throw new PageError(400, "This local folder is not managed by aireg. No files were changed.");
}

function sendAsset(
  response: ServerResponse,
  path: string,
  assets: Readonly<Record<string, Asset>>,
): void {
  const asset = Object.hasOwn(assets, path === "/" ? "/" : path) ? assets[path] : undefined;
  if (asset === undefined) {
    response.writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }
  response.writeHead(200, { ...HEADERS, "content-type": asset.type });
  response.end(asset.body);
}

function send(response: ServerResponse, status: number, document: object): void {
  response.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(document));
}
