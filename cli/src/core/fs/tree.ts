import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { copyRegular } from "#adapter/files.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isStrictlyWithin, posixRelative } from "#core/fs/path.ts";
import { EXECUTABLE, EXECUTE_BITS, PUBLIC_FILE } from "./mode.ts";

export interface FileRecord {
  /** POSIX-relative to the walked root, so digests match across platforms. */
  path: string;
  executable: boolean;
  size: number;
  /** When and which file it was, so a caller can tell an unchanged file without reading it. */
  mtimeMs: number;
  ino: number;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The folders directly in `path`, sorted, leaving out dot folders; none when it cannot be read. */
export async function subdirectories(path: string): Promise<string[]> {
  return (await entries(path))
    .filter((item) => item.isDirectory() && !item.name.startsWith("."))
    .map((item) => item.name)
    .sort();
}

/** A folder that is not there holds nothing; any other failure to read it is reported. */
export async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Whether anything is at `path`, a dangling link included. */
export async function present(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

/** Version-control metadata, OS litter and installed dependencies, which are never an artifact's content. */
const LITTER = new Set([".git", ".hg", ".svn", "CVS", ".DS_Store", "Thumbs.db", "node_modules"]);

/** Names that hold credentials far more often than skill content. */
const SECRET_NAMES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const SECRET_EXTENSIONS = [".key", ".p12", ".pem", ".pfx"];

/** Refused rather than skipped, so a file someone meant to ship is never dropped without a word. */
function maySecret(name: string): boolean {
  if (SECRET_NAMES.has(name)) return true;
  if (/^\.env\./.test(name)) return !/^\.env\.(example|sample|template)$/.test(name);
  const lower = name.toLowerCase();
  return SECRET_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isLitter(name: string): boolean {
  return LITTER.has(name) || name.startsWith("._") || /^\..+\.swp$/.test(name);
}

/** An entry an artifact cannot hold, and why. */
export interface Irregular {
  path: string;
  reason: "is a symlink" | "is not a regular file" | "may hold credentials";
}

/** What index, validate and publish all say about an entry they refuse. */
export function refusal(entry: Irregular): string {
  if (entry.reason === "may hold credentials") {
    return `${entry.reason}; move it out of the artifact folder, since everything there is published`;
  }
  return `${entry.reason}; an artifact holds regular files only`;
}

async function scan(
  root: string,
  authored: boolean,
): Promise<{ files: FileRecord[]; irregular: Irregular[] }> {
  const files: FileRecord[] = [];
  const irregular: Irregular[] = [];
  const pathOf = (full: string) => posixRelative(root, full);

  async function visit(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (authored && isLitter(item.name)) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await visit(full);
        continue;
      }
      if (authored && item.isFile() && maySecret(item.name)) {
        irregular.push({ path: pathOf(full), reason: "may hold credentials" });
        continue;
      }
      if (!item.isFile()) {
        const reason = item.isSymbolicLink() ? "is a symlink" : "is not a regular file";
        irregular.push({ path: pathOf(full), reason });
        continue;
      }
      const info = await stat(full);
      files.push({
        path: pathOf(full),
        executable: (info.mode & EXECUTE_BITS) !== 0,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ino: info.ino,
      });
    }
  }

  if (await isDirectory(root)) await visit(root);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), irregular };
}

/** Sorted, so two walks of the same tree always produce the same list. */
export async function walk(root: string): Promise<FileRecord[]> {
  return (await scan(root, false)).files;
}

/**
 * What an author's folder offers as an artifact: its regular files, without
 * VCS or OS litter, and every symlink or special file it holds, to be refused.
 */
export function authored(root: string): Promise<{ files: FileRecord[]; irregular: Irregular[] }> {
  return scan(root, true);
}

/**
 * A person's own artifact, a folder or one file, read as `authored` reads a folder
 * and refused the same way when it is itself a link. The one file is `path: ""`.
 */
export async function authoredArtifact(
  source: string,
): Promise<{ files: FileRecord[]; irregular: Irregular[] }> {
  const info = await lstat(source);
  if (info.isDirectory()) return scan(source, true);
  const refuse = (reason: Irregular["reason"]) => ({
    files: [],
    irregular: [{ path: "", reason }],
  });
  if (info.isSymbolicLink()) return refuse("is a symlink");
  if (!info.isFile()) return refuse("is not a regular file");
  if (maySecret(basename(source))) return refuse("may hold credentials");
  const file = {
    path: "",
    executable: (info.mode & EXECUTE_BITS) !== 0,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ino: info.ino,
  };
  return { files: [file], irregular: [] };
}

/**
 * A person's own folder or file copied into a scope as a publish would read it:
 * regular files only, never through a link. Returns what it refused instead, if anything.
 */
export async function copyAuthored(source: string, dest: string): Promise<Irregular | undefined> {
  const { files, irregular } = await authoredArtifact(source);
  if (irregular[0] !== undefined) return irregular[0];
  const single = files.length === 1 && files[0]?.path === "";
  // The folder a file sits in is the person's to arrange, links and all; the file is not.
  const root = single ? await realpath(dirname(source)) : source;
  // Built beside `dest` and swapped in whole, so a refusal part way keeps the copy there was.
  const scratch = join(dirname(dest), `.${basename(dest)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await mkdir(single ? dirname(scratch) : scratch, { recursive: true });
    for (const file of files) {
      const path = single ? basename(source) : file.path;
      const to = single ? scratch : join(scratch, ...file.path.split(posix.sep));
      await mkdir(dirname(to), { recursive: true });
      const read = await copyRegular(root, path, to);
      if (read.kind === "file") continue;
      if (read.kind === "refused") return { path: file.path, reason: read.reason };
      throw new AiregError(`${source} changed while it was copied. Run the command again.`, {
        code: ErrorCode.Changed,
      });
    }
    await rm(dest, { recursive: true, force: true });
    await rename(scratch, dest);
    return undefined;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Copy-on-write where the filesystem offers it, so a projection shares blocks
 * until written. `FICLONE` is advisory: elsewhere this is a plain copy.
 */
export async function copyInto(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, {
    recursive: true,
    dereference: true,
    force: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/** A copy inherits its source's modes, and a projection has to be editable. */
export async function unseal(root: string): Promise<void> {
  await mode(root, EXECUTABLE, PUBLIC_FILE);
}

/** A file-shaped kind is one file, not a directory, so both shapes are handled. */
async function mode(root: string, executable: number, plain: number): Promise<void> {
  if (!(await isDirectory(root))) {
    const info = await stat(root).catch(() => undefined);
    if (info === undefined) return;
    await chmod(root, (info.mode & EXECUTE_BITS) !== 0 ? executable : plain).catch(() => {});
    return;
  }
  for (const file of await walk(root)) {
    const full = join(root, ...file.path.split(posix.sep));
    await chmod(full, file.executable ? executable : plain).catch(() => {});
  }
}

export async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Only the immediate parent, since a target root holds the tool's settings;
 * below `ours` every empty folder is aireg's, so those go too.
 */
export async function pruneEmptyParent(path: string, ours?: string): Promise<void> {
  let parent = dirname(path);
  do {
    try {
      if ((await readdir(parent)).length > 0) return;
      await rmdir(parent);
    } catch {
      // Already gone, or not ours to remove.
      return;
    }
    parent = dirname(parent);
  } while (ours !== undefined && isStrictlyWithin(ours, parent));
}
