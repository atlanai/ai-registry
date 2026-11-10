import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { messageOf } from "#adapter/errors.ts";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { underHome } from "#cli/render/home.ts";
import * as commands from "#core/console/actions.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Carried, describeCarried } from "#core/plan/carries.ts";
import { UI_ARCHIVE_DIR, UI_ARCHIVE_NOTE } from "#core/product.ts";
import { toolHome } from "#core/store/paths.ts";
import { Catalogs } from "./catalogs.ts";
import { type Ran, run } from "./child.ts";
import { API_PREFIX, type Bound, refusal } from "./guard.ts";
import { type KeptArtifact, PageReader, type PageState } from "./page-state.ts";

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

interface Offer {
  source: string;
  select: string;
  /** Plugin name to the fingerprint of what it runs, as the dry run read it. */
  plugins: ReadonlyMap<string, string | undefined>;
  atMs: number;
}

/** A yes is given to what a person just read, so an offer goes stale. */
const OFFER_MS = 10 * 60_000;

interface Server {
  reader: PageReader;
  context: CommandContext;
  assets: Readonly<Record<string, Asset>>;
  /** True while a write runs: one at a time, as the lease allows anyway. */
  busy: boolean;
  /** The plugins the last dry run of an address left out until trusted. */
  /** `aireg show` children reading a file a registry serves; a few at a time. */
  showing: number;
  /** The plugins the last dry run held back, each with a digest of what it runs. */
  offer: Offer | undefined;
}

export async function serve(options: ServeOptions): Promise<Serving> {
  const token = randomBytes(32).toString("base64url");
  const server: Server = {
    reader: new PageReader(options.context, new Catalogs(options.context)),
    context: options.context,
    assets: options.assets,
    busy: false,
    showing: 0,
    offer: undefined,
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
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

type Route = (request: IncomingMessage, url: URL, server: Server) => Promise<[number, object]>;

const ROUTES: Readonly<Record<string, Route>> = {
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
    const ran = await run(commands.doctor(), (await server.reader.read()).root);
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
  "GET /api/retired": async () => [200, { ok: true, retired: await retired() }],
  "POST /api/restore": async (request, _url, server) => {
    const payload = await body(request);
    return exclusive(server, async () => {
      const answer = await restore(payload);
      await server.reader.read(true);
      return answer;
    });
  },
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
function artifactsOf(state: PageState): object {
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
      artifacts: state.artifacts.map(
        ({ copy: _copy, installedKey: _key, local: _local, ...shown }) => shown,
      ),
      stats: { total: state.artifacts.length, namespaces, harnesses },
      registries: state.registries,
      problems: state.problems,
      readAtMs: state.readAtMs,
    },
  };
}

function consoleOf(state: PageState): object {
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
  untrusted?: { name: string; registry: string; carries: Carried[]; fingerprint?: string }[];
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

/**
 * Trust goes only to a plugin the last dry run of this same address and selection named,
 * within a few minutes, and only while what it runs is what that dry run read.
 */
function checkTrust(
  offer: Offer | undefined,
  source: string,
  select: string[],
  trust: string[],
): void {
  if (trust.length === 0) return;
  const current =
    offer !== undefined &&
    offer.source === source &&
    offer.select === select.join(",") &&
    Date.now() - offer.atMs < OFFER_MS;
  const unoffered = trust.filter((name) => !current || !offer.plugins.has(name));
  if (unoffered.length > 0) {
    throw new PageError(
      400,
      `Run the dry run first: it did not name ${unoffered.join(", ")} as needing trust.`,
      "A dry run's offer lasts ten minutes.",
    );
  }
  const unfingerprinted = trust.filter((name) => offer?.plugins.get(name) === undefined);
  if (unfingerprinted.length > 0) {
    throw new PageError(
      400,
      `aireg cannot say what ${unfingerprinted.join(", ")} runs, so the page will not trust it.`,
      "Read it, then trust it from the terminal with `aireg add --trust`.",
    );
  }
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
  if (!dryRun) checkTrust(server.offer, source, select, trust);
  const offer = server.offer;
  server.offer = undefined;
  const state = await server.reader.read();
  const plan = commands.add(source, { select, dryRun: true }, state.console.scope);
  if (dryRun) {
    return write(server, plan, (ran) => {
      const untrusted = planOf(ran).untrusted ?? [];
      if (untrusted.length > 0) {
        server.offer = {
          source,
          select: select.join(","),
          plugins: new Map(untrusted.map((p) => [p.name, p.fingerprint])),
          atMs: Date.now(),
        };
      }
      return {
        ok: ran.json?.ok === true,
        dryRun: true,
        source,
        untrusted: untrusted.map((p) => p.name),
        output: dryRunSaid(ran, state.console.scope),
      };
    });
  }
  return exclusive(server, async () => {
    // Read the plan again under the same gate: a source can change between the two clicks.
    if (trust.length > 0) {
      const now = new Map(
        (planOf(await run(plan, state.root)).untrusted ?? []).map((p) => [p.name, p.fingerprint]),
      );
      const changed = trust.filter((name) => now.get(name) !== offer?.plugins.get(name));
      if (changed.length > 0) {
        throw new PageError(
          409,
          `What ${changed.join(", ")} runs changed since the dry run, so nothing was installed.`,
          "Run the dry run again and read it.",
        );
      }
    }
    const ran = await run(
      commands.add(source, { select, trust, dryRun: false, json: true }, state.console.scope),
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

function dryRunSaid(ran: Ran, scope: string): string {
  const planned = planOf(ran);
  const untrusted = planned.untrusted ?? [];
  const said = [
    ...(planned.installed?.length ? [`Would install ${planned.installed.join(", ")}.`] : []),
    ...untrusted.map(
      (p) =>
        `Needs your trust: ${p.name} from ${p.registry} runs ${describeCarried(p.carries)} as you.`,
    ),
    ...(planned.installed?.length && scope === "user"
      ? ["At user scope, aireg also keeps it up to date in the background."]
      : []),
    ...(ran.json?.error?.message === undefined ? [] : [ran.json.error.message]),
    ...ran.lines,
  ];
  return said.length === 0 ? "Nothing would change." : said.join("\n");
}

/** Uninstalls what a registry installed; moves work written here into aireg's own archive. */
async function retire(payload: Record<string, unknown>, server: Server): Promise<[number, object]> {
  const artifact = await find(payload.key, server, true);
  const dryRun = payload.dryRun === true;
  if (artifact.carriedBy !== undefined) {
    throw new PageError(
      400,
      `${artifact.name} comes with the plugin ${artifact.carriedBy}.`,
      `Retire ${artifact.carriedBy} to remove it.`,
    );
  }
  if (artifact.state === "available")
    throw new PageError(400, `${artifact.name} is not installed here.`);
  const where = artifact.harnesses.join(", ") || "every target";
  if (artifact.installedKey !== undefined) {
    const scope = (await server.reader.read()).console.scope;
    const command = commands.remove([artifact.installedKey], scope, dryRun);
    return write(server, command, (ran) => ({
      ok: ran.code === 0,
      dryRun,
      name: artifact.name,
      targets: artifact.harnesses,
      message:
        ran.code === 0
          ? `${dryRun ? "Would remove" : "Removed"} ${artifact.name} from ${where}.`
          : ran.lines.join("\n"),
    }));
  }
  return exclusive(server, async () => {
    const answer = await retireFolder(artifact, dryRun, where);
    if (!dryRun) await server.reader.read(true);
    return answer;
  });
}

/**
 * Work written here: its folder is the source, so it moves aside, never away. The note that
 * says where it came from sits beside it, written first and only as a new file, so nothing
 * inside the folder, such as a link named like the note, is ever written through.
 */
async function retireFolder(
  artifact: KeptArtifact,
  dryRun: boolean,
  where: string,
): Promise<[number, object]> {
  const from = artifact.copy;
  const stat = from === "" ? undefined : await lstat(from).catch(() => undefined);
  if (!artifact.local || !SAFE_NAME.test(artifact.name) || stat?.isDirectory() !== true) {
    throw new PageError(400, `${artifact.name} is not a folder the page can retire.`);
  }
  const id = `${artifact.name}-${Date.now()}`;
  const archived = join(archiveDir(), id);
  if (dryRun) {
    return [
      200,
      {
        ok: true,
        dryRun: true,
        name: artifact.name,
        targets: artifact.harnesses,
        message: `Would move ${underHome(from)} to ${underHome(archived)}, so ${where} stops loading it.`,
      },
    ];
  }
  await mkdir(archiveDir(), { recursive: true });
  const note = notePath(id);
  await writeFile(note, JSON.stringify({ name: artifact.name, from, retiredAtMs: Date.now() }), {
    flag: "wx",
  });
  try {
    await rename(from, archived);
  } catch (error) {
    await rm(note, { force: true });
    throw error;
  }
  return [
    200,
    {
      ok: true,
      name: artifact.name,
      archived: true,
      archivePath: underHome(archived),
      message: `Retired ${artifact.name} to ${underHome(archived)}.`,
    },
  ];
}

function notePath(id: string): string {
  return join(archiveDir(), `${id}${UI_ARCHIVE_NOTE}`);
}

function archiveDir(): string {
  return join(toolHome(), UI_ARCHIVE_DIR);
}

interface Note {
  name: string;
  from: string;
  retiredAtMs: number;
}

async function noteOf(id: string): Promise<Note | undefined> {
  try {
    const note = JSON.parse(await readFile(notePath(id), "utf8")) as Partial<Note>;
    return typeof note.name === "string" && typeof note.from === "string"
      ? (note as Note)
      : undefined;
  } catch {
    return undefined;
  }
}

async function retired(): Promise<object[]> {
  const entries = await readdir(archiveDir(), { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && SAFE_NAME.test(entry.name))
      .map(async (entry) => {
        const note = await noteOf(entry.name);
        return note === undefined
          ? []
          : [
              {
                id: entry.name,
                name: note.name,
                from: underHome(note.from),
                path: underHome(join(archiveDir(), entry.name)),
                description: `Retired from ${underHome(note.from)}`,
                retiredAtMs: note.retiredAtMs,
              },
            ];
      }),
  );
  return found.flat();
}

/** Puts a retired folder back where it came from, and never over something already there. */
async function restore(payload: Record<string, unknown>): Promise<[number, object]> {
  const id = payload.id;
  if (typeof id !== "string" || !SAFE_NAME.test(id))
    throw new PageError(400, "Name one retired folder.");
  const note = await noteOf(id);
  // The note is aireg's own, but a folder outside the home folder is never written to.
  if (note === undefined || !isWithin(homedir(), note.from) || note.from === homedir()) {
    throw new PageError(404, "That retired folder does not say where it came from.");
  }
  if ((await lstat(note.from).catch(() => undefined)) !== undefined) {
    throw new PageError(409, `${underHome(note.from)} already exists, so nothing was moved.`);
  }
  const held = join(archiveDir(), id);
  if ((await lstat(held).catch(() => undefined))?.isDirectory() !== true) {
    throw new PageError(404, "That retired folder is not in the archive.");
  }
  await mkdir(dirname(note.from), { recursive: true });
  await rename(held, note.from);
  await rm(notePath(id), { force: true });
  return [
    200,
    { ok: true, name: note.name, message: `Restored ${note.name} to ${underHome(note.from)}.` },
  ];
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
