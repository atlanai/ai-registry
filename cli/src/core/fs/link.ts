import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { copyInto, isDirectory, remove } from "#core/fs/tree.ts";
import type { LinkMode } from "#core/lock.ts";

/**
 * On macOS /tmp is a symlink to /private/tmp, so the parent is resolved first: a
 * target computed from the unresolved parent is one `lstat` reports as dangling.
 */
async function relativeTarget(source: string, linkPath: string): Promise<string> {
  return relative(await realpath(dirname(linkPath)), await realpath(source));
}

/**
 * Junctions need neither Developer Mode nor elevation, which plain symlinks do
 * on a default Windows install. They only work for directories.
 */
async function windowsLink(source: string, linkPath: string): Promise<LinkMode> {
  if (await isDirectory(source)) {
    await symlink(resolve(source), linkPath, "junction");
    return "junction";
  }
  await copyInto(source, linkPath);
  return "copy";
}

export async function link(source: string, linkPath: string, copyOnly = false): Promise<LinkMode> {
  await mkdir(dirname(linkPath), { recursive: true });
  await remove(linkPath);

  if (copyOnly) {
    await copyInto(source, linkPath);
    return "copy";
  }

  if (process.platform === "win32") return windowsLink(source, linkPath);

  try {
    await symlink(await relativeTarget(source, linkPath), linkPath);
    return "symlink";
  } catch {
    await copyInto(source, linkPath);
    return "copy";
  }
}

/**
 * A file or dot-directory in a plugin is the manifest a target reads itself,
 * and some refuse one reached through a link; content directories stay links.
 */
async function isManifest(path: string, entry: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info !== undefined && (!info.isDirectory() || entry.startsWith("."));
}

/**
 * A real directory mirroring `source`'s top level: a link per content directory and a copy
 * of each manifest. A refresh replaces what changed and drops entries the source lacks.
 */
export async function fanOut(source: string, dir: string): Promise<LinkMode> {
  const info = await lstat(dir).catch(() => undefined);
  if (info !== undefined && !info.isDirectory()) await remove(dir);
  await mkdir(dir, { recursive: true });
  const wanted = new Set(await readdir(source));
  for (const entry of await readdir(dir)) {
    if (!wanted.has(entry)) await remove(join(dir, entry));
  }
  // Each entry names its own path in the source, even where that entry is a
  // link: resolving it would hide which directory this one mirrors.
  const from = await realpath(source);
  const here = await realpath(dir);
  for (const entry of wanted) {
    const at = join(dir, entry);
    const manifest = await isManifest(join(from, entry), entry);
    const target = relative(here, join(from, entry));
    if (manifest ? await sameFile(join(from, entry), at) : await linksTo(at, target)) continue;
    await remove(at);
    if (manifest) {
      await copyInto(join(from, entry), at);
      continue;
    }
    if (process.platform === "win32") {
      await windowsLink(join(from, entry), at);
      continue;
    }
    try {
      await symlink(target, at);
    } catch {
      await copyInto(join(from, entry), at);
    }
  }
  return "fanout";
}

/** Compared resolved, since a Windows junction names its target in full. */
async function linksTo(path: string, target: string): Promise<boolean> {
  const raw = await readlink(path).catch(() => undefined);
  return raw !== undefined && resolve(dirname(path), raw) === resolve(dirname(path), target);
}

/** A copied manifest file that already holds the source's bytes; a manifest folder is always copied again. */
async function sameFile(source: string, copy: string): Promise<boolean> {
  const info = await lstat(copy).catch(() => undefined);
  if (info === undefined || !info.isFile() || !(await stat(source)).isFile()) return false;
  const [left, right] = await Promise.all([readFile(source), readFile(copy)]);
  return left.equals(right);
}

/**
 * The source a fan-out directory mirrors: every link points at the same-named
 * entry of one directory, and every copied manifest is an entry of it too.
 */
async function fanOutSource(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  let source: string | undefined;
  const copied: string[] = [];
  for (const entry of entries) {
    const at = join(dir, entry);
    let raw: string;
    try {
      raw = await readlink(at);
    } catch {
      if (!(await isManifest(at, entry))) return undefined;
      copied.push(entry);
      continue;
    }
    const target = isAbsolute(raw) ? raw : resolve(dir, raw);
    if (basename(target) !== entry) return undefined;
    const parent = dirname(target);
    if (source === undefined) source = parent;
    else if (source !== parent) return undefined;
  }
  // A folder of plain files and no link at all is a person's, not a fan-out.
  if (source === undefined) return undefined;
  for (const entry of copied) {
    if ((await lstat(join(source, entry)).catch(() => undefined)) === undefined) return undefined;
  }
  return source;
}

export interface LinkState {
  exists: boolean;
  isLink: boolean;
  /** Absolute, resolved against the link's own directory. */
  target: string | undefined;
}

export async function inspect(linkPath: string): Promise<LinkState> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(linkPath);
  } catch {
    return { exists: false, isLink: false, target: undefined };
  }
  if (!info.isSymbolicLink()) {
    const source = info.isDirectory() ? await fanOutSource(linkPath) : undefined;
    return { exists: true, isLink: source !== undefined, target: source };
  }

  try {
    const raw = await readlink(linkPath);
    return {
      exists: true,
      isLink: true,
      target: isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw),
    };
  } catch {
    return { exists: true, isLink: true, target: undefined };
  }
}
