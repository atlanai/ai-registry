import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ENVELOPE } from "#adapter/filespec/names.ts";
import { hashStream, sha256 } from "#adapter/spec/canonical.ts";
import { authored, type FileRecord, isDirectory, walk } from "#core/fs/tree.ts";
import { EXECUTE_BITS } from "./mode.ts";

type Listed = Pick<FileRecord, "path" | "size" | "mtimeMs" | "ino" | "executable">;

/** What one digest reads: a folder's files, or one file listed at the path "". */
interface Tree {
  root: string;
  key: string;
  files: readonly Listed[];
  folder: boolean;
}

type Encoding = "framed" | "unframed";

async function hashFile(hash: Hash, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
}

/**
 * Digests already taken, by path, with a stamp of each file's size, modification time
 * and inode: a long-running daemon surveys the same copies every tick, as git's index does.
 */
const KNOWN = new Map<string, { stamp: string } & Partial<Record<Encoding, string>>>();
const KNOWN_LIMIT = 20_000;
/** A write this close to the hash may share its modification time with what was read. */
const RACY_MS = 2_000;

function stampOf(files: readonly Listed[]) {
  return sha256(
    files
      .map((file) => `${file.path}\0${file.size}\0${file.mtimeMs}\0${file.ino}\0${file.executable}`)
      .join("\n"),
  );
}

/** Each file's path, mode, size and content digest as one JSON list, so no two trees share it. */
async function framed(tree: Tree): Promise<string> {
  const entries: [string, boolean, number, string][] = [];
  const ordered = [...tree.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    const read = await hashStream(createReadStream(join(tree.root, file.path)));
    entries.push([file.path, file.executable, read.size, read.digest]);
  }
  return sha256(JSON.stringify(entries));
}

/** What older locks record. It runs one file into the next, so it is matched, never written. */
async function unframed(tree: Tree): Promise<string> {
  const hash = createHash("sha256");
  for (const file of tree.files) {
    if (tree.folder) hash.update(`${file.path} ${file.executable ? "1" : "0"} `);
    await hashFile(hash, join(tree.root, file.path));
    if (tree.folder) hash.update(" ");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function taken(tree: Tree, encoding: Encoding): Promise<string> {
  const stamp = stampOf(tree.files);
  const known = KNOWN.get(tree.key);
  const held = known?.stamp === stamp ? known : { stamp };
  const value = held[encoding] ?? (await (encoding === "framed" ? framed : unframed)(tree));
  const newestMs = tree.files.reduce((newest, file) => Math.max(newest, file.mtimeMs), 0);
  if (Date.now() - newestMs >= RACY_MS) {
    KNOWN.delete(tree.key);
    KNOWN.set(tree.key, { ...held, [encoding]: value });
    const [oldest] = KNOWN.keys();
    if (KNOWN.size > KNOWN_LIMIT && oldest !== undefined) KNOWN.delete(oldest);
  }
  return value;
}

/** `recorded` stands when it is the unframed digest of these files, so older locks read as untouched. */
async function settle(tree: Tree, recorded: string | undefined): Promise<string> {
  const now = await taken(tree, "framed");
  if (recorded === undefined || recorded === "" || recorded === now) return now;
  return (await taken(tree, "unframed")) === recorded ? recorded : now;
}

async function lone(path: string): Promise<Tree> {
  const info = await stat(path);
  const executable = (info.mode & EXECUTE_BITS) !== 0;
  const file = { path: "", size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, executable };
  return { root: path, key: path, files: [file], folder: false };
}

function folder(path: string, key: string, files: readonly FileRecord[]): Tree {
  return { root: path, key, files: files.filter((file) => file.path !== ENVELOPE), folder: true };
}

/**
 * Has the copy on disk been edited since we placed it? Given the digest a lock records
 * for it, that digest is returned when the copy still matches it.
 */
export async function digest(path: string, recorded?: string): Promise<string> {
  const tree = (await isDirectory(path)) ? folder(path, path, await walk(path)) : await lone(path);
  return settle(tree, recorded);
}

/**
 * What a person's own folder holds as a copy of it holds it (`copyAuthored`), so the
 * two digest alike: litter and anything refused are left out.
 */
export async function authoredDigest(path: string, recorded?: string): Promise<string> {
  if (!(await isDirectory(path))) return settle(await lone(path), recorded);
  return settle(folder(path, `${path}\0authored`, (await authored(path)).files), recorded);
}
