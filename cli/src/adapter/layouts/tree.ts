import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { EXECUTE_BITS } from "../files.ts";
import { type ReadPath, SpecError } from "../filespec/documents.ts";
import { registryPath, rootReader } from "../filespec/folder.ts";
import { plural } from "../text.ts";

/** How much of a source one read may walk. A source is untrusted, so each is a hard stop. */
export interface TreeLimits {
  /** Folders below the folder a walk starts at. */
  depth: number;
  /** Files across every walk of one source. */
  files: number;
  /** Bytes across every walk of one source. */
  bytes: number;
}

const MB = 1024 * 1024;

export const TREE_LIMITS: TreeLimits = { depth: 12, files: 10_000, bytes: 256 * MB };

/** Folders a source keeps for its own tooling, never content. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist", "build"]);

/** A hidden folder is skipped unless a layout reads it, as Claude Code and Codex folders are. */
const READ_HIDDEN = new Set([".claude", ".agents", ".claude-plugin", ".codex-plugin"]);

/** Files an operating system leaves behind, which no artifact means to ship. */
const OS_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** One regular file, POSIX and relative to the tree's root. */
interface TreeFile {
  path: string;
  size: number;
  executable: boolean;
}

/** Something a walk left out, for a warning. */
export interface Skip {
  path: string;
  /** Lowercase, to end a sentence with: `is a symlink`. */
  reason: string;
}

/** One entry of a folder, as `list` gives it. */
interface TreeEntry {
  name: string;
  /** POSIX, relative to the root. */
  path: string;
  type: "file" | "folder" | "link" | "other";
}

/** A folder on disk read without following a link, within the limits it was opened with. */
export interface Tree {
  /** The folder every path is relative to. */
  root: string;
  /** What a folder holds, sorted by name; nothing when it is not there. */
  list(dir: string): Promise<TreeEntry[]>;
  /** Every regular file below `dir`, sorted by path, with what was left out. */
  walk(dir: string): Promise<{ files: TreeFile[]; skipped: Skip[] }>;
  /** One file's bytes, refusing a link anywhere on the way. */
  read: ReadPath;
  /** Whether `path` is a regular file, reached without a link. */
  isFile(path: string): Promise<boolean>;
}

function typeOf(entry: Dirent): TreeEntry["type"] {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "folder";
  if (entry.isFile()) return "file";
  return "other";
}

const at = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);

/** Whether a walk descends into a folder of this name. */
export function walksInto(name: string): boolean {
  if (SKIPPED_FOLDERS.has(name)) return false;
  return !name.startsWith(".") || READ_HIDDEN.has(name);
}

type Step =
  | { kind: "descend" }
  | { kind: "skip"; skip: Skip }
  | { kind: "file"; file: TreeFile }
  | { kind: "none" };

/** What a walk does with one entry: descend into it, keep it, or say why it was left out. */
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

/** Opens `root` for bounded reading. The root itself must not be a link. */
export async function openTree(root: string, limits: TreeLimits = TREE_LIMITS): Promise<Tree> {
  await registryPath(root, "", true);
  const reader = rootReader(root);
  let files = 0;
  let bytes = 0;

  const list = async (dir: string): Promise<TreeEntry[]> => {
    const folder = dir === "" ? root : await registryPath(root, dir);
    const entries = await readdir(folder, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
        throw new SpecError(`${dir || "."} cannot be read: ${error.message}`, { path: dir });
      },
    );
    return entries
      .map((entry) => ({ name: entry.name, path: at(dir, entry.name), type: typeOf(entry) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

  /** A listed file as it is now: changed into something else since, it is left out, never followed. */
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
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
