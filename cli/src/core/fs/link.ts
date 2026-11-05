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
import { ifPresent, ifReadable, isAbsent } from "#adapter/files.ts";
import { copyInto, isDirectory, remove } from "#core/fs/tree.ts";
import type { LinkMode } from "#core/lock.ts";

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
    // Whether a filesystem or a policy refuses the link, a copy still installs.
    await copyInto(source, linkPath);
    return "copy";
  }
}

/** Junctions need no Developer Mode or elevation, unlike Windows symlinks; folders only. */
async function windowsLink(source: string, linkPath: string): Promise<LinkMode> {
  if (await isDirectory(source)) {
    await symlink(resolve(source), linkPath, "junction");
    return "junction";
  }
  await copyInto(source, linkPath);
  return "copy";
}

/**
 * On macOS /tmp is a symlink to /private/tmp, so the parent is resolved first: a
 * target computed from the unresolved parent is one `lstat` reports as dangling.
 */
async function relativeTarget(source: string, linkPath: string): Promise<string> {
  return relative(await realpath(dirname(linkPath)), await realpath(source));
}

/**
 * A link per content directory and a copy of each manifest. A refresh replaces what changed
 * and drops entries the source lacks.
 */
export async function fanOut(source: string, dir: string): Promise<LinkMode> {
  const info = await ifPresent(lstat(dir));
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
      // An entry that cannot be linked is copied.
      await copyInto(join(from, entry), at);
    }
  }
  return "fanout";
}

/**
 * A file or dot-directory in a plugin is the manifest a target reads itself,
 * and some refuse one reached through a link; content directories stay links.
 */
async function isManifest(path: string, entry: string): Promise<boolean> {
  const info = await ifPresent(stat(path));
  return info !== undefined && (!info.isDirectory() || entry.startsWith("."));
}

/**
 * Whether a copied manifest file holds the source's bytes; a manifest folder is recopied.
 * Read, then check: a folder fails to read, and a link where the copy belongs is not a copy.
 */
async function sameFile(source: string, copy: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [readFile(source), readFile(copy)].map((read) => read.catch(() => undefined)),
  );
  if (left === undefined || right === undefined || !left.equals(right)) return false;
  return (await ifPresent(lstat(copy)))?.isFile() === true;
}

/** Compared resolved, since a Windows junction names its target in full. */
async function linksTo(path: string, target: string): Promise<boolean> {
  // Anything that is not a link refuses readlink, with a code that differs by platform.
  const raw = await readlink(path).catch(() => undefined);
  return raw !== undefined && resolve(dirname(path), raw) === resolve(dirname(path), target);
}

export async function inspect(linkPath: string): Promise<LinkState> {
  const info = await ifReadable(lstat(linkPath));
  if (info === undefined) return { exists: false, isLink: false, target: undefined };
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
  } catch (error) {
    // Removed between the two reads.
    if (isAbsent(error)) return { exists: true, isLink: true, target: undefined };
    throw error;
  }
}

export interface LinkState {
  exists: boolean;
  isLink: boolean;
  /** Absolute, resolved against the link's own directory. */
  target: string | undefined;
}

/** Every link points at the same-named entry of one directory, as every copied manifest is. */
async function fanOutSource(dir: string): Promise<string | undefined> {
  const entries = await ifPresent(readdir(dir));
  if (entries === undefined) return undefined;
  let source: string | undefined;
  const copied: string[] = [];
  for (const entry of entries) {
    const at = join(dir, entry);
    let raw: string;
    try {
      raw = await readlink(at);
    } catch {
      // Not a link, whatever code this platform's readlink gives for that.
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
    if ((await ifPresent(lstat(join(source, entry)))) === undefined) return undefined;
  }
  return source;
}
