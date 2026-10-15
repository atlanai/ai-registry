import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, lstatSync, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { assertWithin } from "./paths.ts";
import { hashStream } from "./spec/canonical.ts";

// Reading and writing files under a root without being redirected by a link,
// for any adapter whose store is a folder on disk.

/** Modes a copied file is written with, and the mask that says it was executable. */
export const PUBLIC_FILE = 0o644;
export const EXECUTABLE = 0o755;
export const EXECUTE_BITS = 0o111;

/** Why a path under a root was not read. */
export type RefusedReason = "is a symlink" | "is not a regular file";

export type Regular =
  | { kind: "file"; bytes: Buffer; executable: boolean }
  | { kind: "missing" }
  | { kind: "refused"; reason: RefusedReason };

/**
 * A file under `root` opened without following a link at any step. `verified` holds
 * folders already checked in this pass, which are not checked again.
 */
async function openRegular(
  root: string,
  path: string,
  verified?: Set<string>,
): Promise<
  | { kind: "open"; handle: FileHandle; executable: boolean }
  | { kind: "missing" }
  | { kind: "refused"; reason: RefusedReason }
> {
  const parts = path.split(posix.sep);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${path} is not a path inside ${root}.`);
  }
  if (verified?.has(root) !== true) {
    const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (rootInfo === undefined) return { kind: "missing" };
    if (rootInfo.isSymbolicLink()) return { kind: "refused", reason: "is a symlink" };
    if (!rootInfo.isDirectory()) return { kind: "refused", reason: "is not a regular file" };
    verified?.add(root);
  }
  const leaf = join(root, ...parts);
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    if (at !== leaf && verified?.has(at) === true) continue;
    const info = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (info === undefined) return { kind: "missing" };
    if (info.isSymbolicLink()) return { kind: "refused", reason: "is a symlink" };
    if (at === leaf && !info.isFile()) return { kind: "refused", reason: "is not a regular file" };
    if (at !== leaf && info.isDirectory()) verified?.add(at);
  }
  // O_NOFOLLOW closes the gap between the check above and the open.
  const handle = await open(at, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    return { kind: "refused", reason: "is not a regular file" };
  }
  return { kind: "open", handle, executable: (info.mode & EXECUTE_BITS) !== 0 };
}

/**
 * A file under `root` read without following a link at any step, so the bytes
 * can only ever come from inside it. `path` is POSIX and relative.
 */
export async function readRegular(
  root: string,
  path: string,
  verified?: Set<string>,
): Promise<Regular> {
  const opened = await openRegular(root, path, verified);
  if (opened.kind !== "open") return opened;
  try {
    return { kind: "file", bytes: await opened.handle.readFile(), executable: opened.executable };
  } finally {
    await opened.handle.close();
  }
}

/** Like `readRegular`, but streamed into a digest, so a large file is never held whole. */
export async function hashRegular(
  root: string,
  path: string,
): Promise<
  | { kind: "file"; digest: string; size: number }
  | { kind: "missing" }
  | { kind: "refused"; reason: RefusedReason }
> {
  const opened = await openRegular(root, path);
  if (opened.kind !== "open") return opened;
  try {
    const hashed = await hashStream(opened.handle.createReadStream({ autoClose: false }));
    return { kind: "file", ...hashed };
  } finally {
    await opened.handle.close();
  }
}

/**
 * Like `hashRegular`, but also streamed to `dest`, which must not exist yet: a caller
 * lands it under its own name once the digest is checked.
 */
export async function copyRegular(
  root: string,
  path: string,
  dest: string,
): Promise<
  | { kind: "file"; digest: string; size: number; executable: boolean }
  | { kind: "missing" }
  | { kind: "refused"; reason: RefusedReason }
> {
  const opened = await openRegular(root, path);
  if (opened.kind !== "open") return opened;
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      opened.handle.createReadStream({ autoClose: false }),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(dest, { flags: "wx", mode: opened.executable ? EXECUTABLE : PUBLIC_FILE }),
    );
  } finally {
    await opened.handle.close();
  }
  return {
    kind: "file",
    digest: `sha256:${hash.digest("hex")}`,
    size,
    executable: opened.executable,
  };
}

/** The first component below a boundary that is a link, or not a directory where one must be. */
interface Redirection {
  at: string;
  problem: "symlink" | "not-directory";
}

/** Synchronous so planning can ask; `assertUnredirected` asks again at write time. */
export function redirection(
  root: string,
  path: string,
  includeLeaf = true,
  /** Folders already found to be real ones in this pass, which are not checked again. */
  verified?: Set<string>,
): Redirection | undefined {
  const base = resolve(root);
  const target = resolve(includeLeaf ? path : dirname(path));
  assertWithin(base, target, "managed path");
  const suffix = relative(base, target);
  let at = base;
  for (const part of ["", ...(suffix === "" ? [] : suffix.split(sep))]) {
    at = join(at, part);
    if (at !== target && verified?.has(at) === true) continue;
    let info: Stats;
    try {
      info = lstatSync(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) return { at, problem: "symlink" };
    if (at !== target && !info.isDirectory()) return { at, problem: "not-directory" };
    if (at !== target) verified?.add(at);
  }
  return undefined;
}

/**
 * Refuses links below the caller-selected `root`: lexical containment alone lets a checked-in
 * directory link redirect a copy, rename or recursive removal. Not a guard against concurrent swaps.
 */
export async function assertUnredirected(
  root: string,
  path: string,
  includeLeaf = true,
  verified?: Set<string>,
): Promise<void> {
  const found = redirection(root, path, includeLeaf, verified);
  if (found?.problem === "symlink") throw new Error(`${found.at} is a symlink in a managed path.`);
  if (found !== undefined) throw new Error(`${found.at} is not a directory.`);
}

function scratch(target: string): string {
  return join(dirname(target), `.${process.pid}-${randomUUID()}.tmp`);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const unsupported = new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);
    if (!unsupported.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Long enough for a reader or a virus scan to let go; a held lease is refused well before. */
const REPLACE_RETRY_MS = 5_000;
const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Windows refuses to replace a file another process has open, as the daemon reading a
 * manifest or a virus scan of a fresh write briefly does; elsewhere the rename is atomic.
 */
export async function replaceFile(
  temp: string,
  target: string,
  before: (() => Promise<void>) | undefined,
  move: (from: string, to: string) => Promise<void> = rename,
  platform: NodeJS.Platform = process.platform,
  retryMs = REPLACE_RETRY_MS,
): Promise<void> {
  const deadline = Date.now() + retryMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
    await before?.();
    try {
      await move(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !HELD.has(code) || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * A killed process leaves the old file or the new one, never half of either: the
 * scratch sibling keeps the rename on one filesystem, and `mode` precedes it.
 */
export async function writeAtomic(
  target: string,
  contents: string | Uint8Array,
  options: {
    mode?: number;
    /** False skips the syncs, for files a caller can simply write again after a crash. */
    durable?: boolean;
    /** Runs before each attempt to land the file; a throw leaves the old one. */
    beforeRename?: () => Promise<void>;
  } = {},
): Promise<void> {
  const { mode = PUBLIC_FILE, durable = true } = options;
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = scratch(target);
  const file = await open(temp, "wx", mode);
  try {
    if (typeof contents === "string") await file.writeFile(contents, "utf8");
    else await file.writeFile(contents);
    await file.chmod(mode);
    if (durable) await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  await file.close();

  try {
    await replaceFile(temp, target, options.beforeRename);
    if (durable) await syncDirectory(parent);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
