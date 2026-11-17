import { createHash } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { acquire } from "#core/lease/lease.ts";
import { UI_DEFAULT_PORT, UI_RUNTIME_PREFIX, UI_SOCKET_FILE } from "#core/product.ts";
import { roots, toolHome } from "#core/store/paths.ts";
import { type ServeOptions, type Serving, serve } from "./server.ts";

type Address = Pick<Serving, "url" | "port">;
export interface Instance extends Address {
  /** Only the process which started the server owns its lifetime. */
  close?: () => Promise<void>;
}

async function endpoint(): Promise<string> {
  const identity = createHash("sha256").update(toolHome()).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\${UI_RUNTIME_PREFIX}-${identity}`;
  const folder = join(tmpdir(), `${UI_RUNTIME_PREFIX}-${process.getuid?.()}-${identity}`);
  await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return checkedFolder(folder);
}

async function checkedFolder(folder: string): Promise<string> {
  const info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new AiregError("The UI launcher directory is not private.", { code: ErrorCode.Invalid });
  }
  return join(folder, UI_SOCKET_FILE);
}

/** Credentials travel only over a private local socket, never to an unverified HTTP port. */
function existing(path: string): Promise<Address | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let text = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("The existing UI did not answer.")));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.length > 4096) socket.destroy(new Error("Invalid UI launcher reply."));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
    socket.on("end", () => {
      try {
        const address = JSON.parse(text) as Address;
        const url = new URL(address.url);
        if (
          url.origin !== `http://127.0.0.1:${address.port}` ||
          !/^#token=[\w-]{43}$/.test(url.hash)
        ) {
          throw new Error("Invalid UI launcher address.");
        }
        resolve(address);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(path, () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
}

async function start(options: Omit<ServeOptions, "port"> & { port?: number }): Promise<Serving> {
  try {
    return await serve({ ...options, port: options.port ?? UI_DEFAULT_PORT });
  } catch (error) {
    if (
      options.port !== undefined ||
      !(error instanceof AiregError) ||
      error.code !== ErrorCode.Unavailable
    )
      throw error;
    return serve({ ...options, port: 0 });
  }
}

/** One owner per aireg home; callers reopen it, including when it uses a fallback port. */
export async function openInstance(
  options: Omit<ServeOptions, "port"> & { port?: number },
): Promise<Instance> {
  // Serialize discovery and stale-socket recovery using the existing CLI lease.
  // Release it before the browser opens; UI actions take their own normal leases.
  const lease = await acquire(roots("user", options.context.cwd), { wait: true });
  try {
    return await openOwned(options, await endpoint());
  } finally {
    await lease.release();
  }
}

async function openOwned(
  options: Omit<ServeOptions, "port"> & { port?: number },
  path: string,
): Promise<Instance> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prior = await existing(path);
    if (prior !== undefined) {
      if (options.port !== undefined && options.port !== prior.port)
        throw new AiregError(`The UI is already running on port ${prior.port}.`, {
          code: ErrorCode.Unavailable,
          hint: "Run aireg ui without --port to reopen it.",
        });
      return prior;
    }
    let ready: (address: Address | undefined) => void = () => {};
    const address = new Promise<Address | undefined>((resolve) => {
      ready = resolve;
    });
    const ipc = createServer((socket) => {
      socket.on("error", () => {});
      void address.then((value) => socket.end(value === undefined ? "" : JSON.stringify(value)));
    });
    try {
      await listen(ipc, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if ((await existing(path)) !== undefined) continue;
      if (process.platform !== "win32") {
        const stat = await lstat(path).catch(() => undefined);
        if (stat?.isSocket() && stat.uid === process.getuid?.()) await unlink(path).catch(() => {});
      }
      continue;
    }
    try {
      const serving = await start(options);
      ready(serving);
      return {
        url: serving.url,
        port: serving.port,
        close: async () => {
          await serving.close();
          await new Promise<void>((resolve) => ipc.close(() => resolve()));
        },
      };
    } catch (error) {
      ready(undefined);
      ipc.close();
      throw error;
    }
  }
  throw new AiregError("The UI is starting in another process. Try again.", {
    code: ErrorCode.Unavailable,
  });
}
