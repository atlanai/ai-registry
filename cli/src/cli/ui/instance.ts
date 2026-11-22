import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { shortHash } from "#core/fs/hash.ts";
import { PRIVATE_DIR, PRIVATE_FILE } from "#core/fs/mode.ts";
import { processAlive } from "#core/process.ts";
import { UI_DEFAULT_PORT, UI_RUNTIME_DIR } from "#core/product.ts";
import { toolHome } from "#core/store/paths.ts";
import { HEALTH_PATH, instanceId } from "./guard.ts";
import { type ServeOptions, type Serving, serve } from "./server.ts";

/** What a running `aireg ui` leaves for the next launch in the same folder. */
interface Runtime {
  pid: number;
  port: number;
  token: string;
}

export interface Instance {
  /** Carries the token after `#`, which a browser never sends to a server. */
  url: string;
  port: number;
  /** Only the process which started the server owns its lifetime. */
  close?: () => Promise<void>;
}

type OpenOptions = Omit<ServeOptions, "port"> & { port?: number };

function launchUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${token}`;
}

/** One server per aireg home and folder; a later launch in the same folder reopens it. */
export async function openInstance(options: OpenOptions): Promise<Instance> {
  const root = await realpath(options.context.cwd);
  const file = await runtimeFile(root);
  // Its own lock, not the scope's lease, so an install that is running never holds a launch up.
  const release = await lock(`${file}.lock`);
  try {
    const prior = await readRuntime(file);
    if (prior !== undefined && processAlive(prior.pid) && (await answers(prior))) {
      if (options.port !== undefined && options.port !== prior.port) {
        throw new AiregError(`The UI is already running on port ${prior.port}.`, {
          code: ErrorCode.Unavailable,
          hint: "Run aireg ui without --port to reopen it.",
        });
      }
      return { url: launchUrl(prior.port, prior.token), port: prior.port };
    }
    await unlink(file).catch(() => {});
    const serving = await start(options);
    const runtime: Runtime = { pid: process.pid, port: serving.port, token: serving.token };
    await writeRuntime(file, runtime).catch(async (error: unknown) => {
      await serving.close();
      throw error;
    });
    return {
      url: launchUrl(serving.port, serving.token),
      port: serving.port,
      close: async () => {
        await serving.close();
        // Leave a file a newer server wrote in its place.
        if ((await readRuntime(file))?.token === serving.token) await unlink(file).catch(() => {});
      },
    };
  } finally {
    await release();
  }
}

/** Longer than a health check and a server start; past it, another launch is stuck. */
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

/**
 * Held while one launch looks for a server and starts one. A holder that died leaves its file,
 * which the next launch moves aside only if it still names that holder.
 */
async function lock(path: string, waitMs = LOCK_WAIT_MS): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  const mine = `${process.pid} ${randomUUID()}`;
  for (;;) {
    const handle = await open(path, "wx", PRIVATE_FILE).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return undefined;
      throw error;
    });
    if (handle !== undefined) {
      try {
        await handle.writeFile(mine);
      } finally {
        await handle.close();
      }
      return async () => {
        if ((await holderOf(path)) === mine) await unlink(path).catch(() => {});
      };
    }
    const holder = await holderOf(path);
    if (holder !== undefined && (await abandoned(path, holder))) await moveAside(path, holder);
    else if (Date.now() >= deadline) {
      throw new AiregError("Another aireg ui is still starting in this folder.", {
        code: ErrorCode.Unavailable,
        hint: `Try again in a moment, or remove ${path} if no aireg ui is running.`,
      });
    } else await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function holderOf(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/** A holder's pid is gone, or it never wrote its name and has had long enough to. */
async function abandoned(path: string, holder: string): Promise<boolean> {
  const pid = Number(holder.split(" ")[0]);
  if (Number.isSafeInteger(pid) && pid > 0) return !processAlive(pid);
  const info = await stat(path).catch(() => undefined);
  return info !== undefined && Date.now() - info.mtimeMs > LOCK_WAIT_MS;
}

/** Renamed first, so a lock another launch took meanwhile goes back unless a third took its place. */
async function moveAside(path: string, holder: string): Promise<void> {
  const aside = `${path}.${randomUUID()}`;
  if (
    !(await rename(path, aside).then(
      () => true,
      () => false,
    ))
  )
    return;
  if ((await holderOf(aside)) !== holder) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}

async function start(options: OpenOptions): Promise<Serving> {
  try {
    return await serve({ ...options, port: options.port ?? UI_DEFAULT_PORT });
  } catch (error) {
    const taken = error instanceof AiregError && error.code === ErrorCode.Unavailable;
    if (options.port !== undefined || !taken) throw error;
    return serve({ ...options, port: 0 });
  }
}

/** Keyed by the folder as well as the home: a launch elsewhere serves that folder's state. */
async function runtimeFile(root: string): Promise<string> {
  const folder = join(toolHome(), UI_RUNTIME_DIR);
  await mkdir(folder, { recursive: true, mode: PRIVATE_DIR });
  const info = await lstat(folder);
  if (!info.isDirectory() || (isPosix() && (!ownedByMe(info.uid) || (info.mode & 0o077) !== 0))) {
    throw new AiregError(`${folder} is not private to you.`, {
      code: ErrorCode.Invalid,
      hint: `Remove it, or run chmod 700 ${folder}.`,
    });
  }
  return join(folder, `${shortHash(root)}.json`);
}

/** Undefined for anything this process did not write: a link, someone else's, or malformed. */
async function readRuntime(file: string): Promise<Runtime | undefined> {
  // Check and read through one handle, so the file cannot be swapped in between.
  const handle = await open(file, NO_FOLLOW).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (isPosix() && (!ownedByMe(info.uid) || (info.mode & 0o077) !== 0)) return undefined;
    const read = JSON.parse(await handle.readFile("utf8")) as Partial<Runtime>;
    const valid =
      Number.isSafeInteger(read.pid) &&
      Number.isInteger(read.port) &&
      (read.port ?? 0) > 0 &&
      (read.port ?? 0) < 65536 &&
      typeof read.token === "string" &&
      /^[\w-]{43}$/.test(read.token);
    return valid ? (read as Runtime) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Refuses a link in the file's place; Windows has no such flag. */
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

async function writeRuntime(file: string, runtime: Runtime): Promise<void> {
  const handle = await open(file, "wx", PRIVATE_FILE);
  try {
    await handle.writeFile(`${JSON.stringify(runtime)}\n`);
  } finally {
    await handle.close();
  }
}

/** A recycled pid or port answers too, so the server must name the token it was started with. */
function answers(runtime: Runtime): Promise<boolean> {
  return new Promise((resolve) => {
    const asked = request(
      {
        host: "127.0.0.1",
        port: runtime.port,
        path: HEALTH_PATH,
        headers: { host: `127.0.0.1:${runtime.port}` },
        timeout: 2_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(
              (JSON.parse(body) as { instance?: unknown }).instance === instanceId(runtime.token),
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    asked.on("timeout", () => asked.destroy());
    asked.on("error", () => resolve(false));
    asked.end();
  });
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

function ownedByMe(uid: number): boolean {
  return uid === process.getuid?.();
}
