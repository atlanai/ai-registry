import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { EXECUTE_BITS, isAbsent } from "../files.ts";
import { type ReadPath, SpecError } from "../filespec/documents.ts";
import { registryPath, rootReader } from "../filespec/folder.ts";
import { byCodeUnit, plural } from "../text.ts";

/** A source is untrusted, so each limit is a hard stop. */
export interface TreeLimits {
  /** Counted from the folder a walk starts at. */
  depth: number;
  /** Counted across every walk of one source, as `bytes` is. */
  files: number;
  bytes: number;
}

const MB = 1024 * 1024;

export const TREE_LIMITS: TreeLimits = { depth: 12, files: 10_000, bytes: 256 * MB };

const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist", "build"]);

// Hidden folders are skipped except these, which layouts read.
const READ_HIDDEN = new Set([".claude", ".agents", ".claude-plugin", ".codex-plugin"]);

const OS_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

interface TreeFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface Skip {
  path: string;
  /** Ends a sentence, such as `is a symlink`. */
  reason: string;
}

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "folder" | "link" | "other";
}

/** A folder on disk read without following a link, within its limits. */
export interface Tree {
  root: string;
  /** Sorted by name; empty when the folder is not there. */
  list(dir: string): Promise<TreeEntry[]>;
  /** Regular files sorted by path. */
  walk(dir: string): Promise<{ files: TreeFile[]; skipped: Skip[] }>;
  /** Refuses a link anywhere on the way. */
  read: ReadPath;
  isFile(path: string): Promise<boolean>;
}

export function walksInto(name: string): boolean {
  if (SKIPPED_FOLDERS.has(name)) return false;
  return !name.startsWith(".") || READ_HIDDEN.has(name);
}

const at = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);

/** The root itself must not be a link. */
export async function openTree(root: string, limits: TreeLimits = TREE_LIMITS): Promise<Tree> {
  await registryPath(root, "", true);
  const reader = rootReader(root);
  let files = 0;
  let bytes = 0;

  const list = async (dir: string): Promise<TreeEntry[]> => {
    const folder = dir === "" ? root : await registryPath(root, dir);
    const entries = await readdir(folder, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (isAbsent(error)) return [];
        throw new SpecError(`${dir || "."} cannot be read: ${error.message}`, { path: dir });
      },
    );
    return entries
      .map((entry) => ({ name: entry.name, path: at(dir, entry.name), type: typeOf(entry) }))
      .sort((a, b) => byCodeUnit(a.name, b.name));
  };

  const count = (path: string, size: number): void => {
    files += 1;
    bytes += size;
    if (files > limits.files) {
      throw new SpecError(`This source holds more than ${plural(limits.files, "file")}.`, {
        path,
        hint: "Add a folder inside it that holds the skills, rather than the whole of it.",
      });
    }
    if (bytes > limits.bytes) {
      throw new SpecError(
        `This source holds more than ${limits.bytes >= MB ? `${Math.round(limits.bytes / MB)} MB` : plural(limits.bytes, "byte")}.`,
        {
          path,
          hint: "Add a folder inside it that holds the skills, rather than the whole of it.",
        },
      );
    }
  };

  // A file that changed into something else since it was listed is left out, not followed.
  const fileAt = async (path: string): Promise<TreeFile | Skip> => {
    const info = await lstat(join(root, ...path.split(posix.sep)));
    if (!info.isFile()) return { path, reason: "is not a regular file" };
    count(path, info.size);
    return { path, size: info.size, executable: (info.mode & EXECUTE_BITS) !== 0 };
  };

  const walk = async (dir: string) => {
    const found: TreeFile[] = [];
    const skipped: Skip[] = [];
    const descend = async (folder: string, depth: number): Promise<void> => {
      for (const entry of await list(folder)) {
        const step = await stepOf(entry, depth, limits, fileAt);
        if (step.kind === "descend") await descend(entry.path, depth + 1);
        else if (step.kind === "skip") skipped.push(step.skip);
        else if (step.kind === "file") found.push(step.file);
      }
    };
    await descend(dir, 0);
    found.sort((a, b) => byCodeUnit(a.path, b.path));
    return { files: found, skipped };
  };

  return {
    root,
    list,
    walk,
    read: reader,
    async isFile(path) {
      const parent = posix.dirname(path);
      const name = posix.basename(path);
      const entries = await list(parent === "." ? "" : parent);
      return entries.some((entry) => entry.name === name && entry.type === "file");
    },
  };
}

function typeOf(entry: Dirent): TreeEntry["type"] {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "folder";
  if (entry.isFile()) return "file";
  return "other";
}

type Step =
  | { kind: "descend" }
  | { kind: "skip"; skip: Skip }
  | { kind: "file"; file: TreeFile }
  | { kind: "none" };

async function stepOf(
  entry: TreeEntry,
  depth: number,
  limits: TreeLimits,
  fileAt: (path: string) => Promise<TreeFile | Skip>,
): Promise<Step> {
  if (entry.type === "link")
    return { kind: "skip", skip: { path: entry.path, reason: "is a symlink" } };
  if (entry.type === "other") {
    return { kind: "skip", skip: { path: entry.path, reason: "is not a regular file" } };
  }
  if (entry.type === "folder") {
    if (!walksInto(entry.name)) return { kind: "none" };
    if (depth >= limits.depth) {
      throw new SpecError(`${entry.path} is nested more than ${limits.depth} folders deep.`, {
        path: entry.path,
      });
    }
    return { kind: "descend" };
  }
  if (OS_FILES.has(entry.name)) return { kind: "none" };
  const file = await fileAt(entry.path);
  return "reason" in file ? { kind: "skip", skip: file } : { kind: "file", file };
}
