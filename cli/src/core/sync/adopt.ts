import type { Dirent } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { isWithin } from "#adapter/paths.ts";
import { inspect } from "#core/fs/link.ts";
import { posixRelative } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { KIND_SPECS, SCANNED_KINDS } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { entriesIn } from "#core/sync/scan.ts";
import type { KindMapping, Targets } from "#core/target/contract.ts";
import { targetRoot } from "#core/target/roots.ts";

export interface Candidate {
  name: string;
  kind: ArtifactKind;
  /** Absolute path to the content a person wrote. */
  from: string;
  /** Target it was found in, so a report can say where. */
  target: string;
  /** Where it would sit in a registry laid out the standard way. */
  suggestedPath: string;
  description: string | undefined;
  /** The same artifact in the other target directories, which a report names once. */
  elsewhere: { from: string; target: string }[];
}

/** Where a registry would file this kind: the scanner's table read the other way, so a scan finds it again. */
export function registryPath(kind: ArtifactKind, name: string, from: string): string {
  const spec = KIND_SPECS[kind];
  if (spec.shape === "directory") return posix.join(spec.dir, name);
  const dot = from.lastIndexOf(".");
  const extension = dot > 0 ? from.slice(dot) : (spec.extensions[0] ?? "");
  return posix.join(spec.dir, `${name}${extension}`);
}

/**
 * The reverse of projection: anything in a target directory that is not a link
 * into this scope's own trees, and that the lock does not claim, is local work.
 */
export async function candidates(
  roots: Roots,
  targetTable: Targets,
  targets: readonly string[],
  lock: Lock,
  /**
   * `kind:name` for everything the registries publish. A name they already
   * publish is not local work; it is an artifact this project has not declared.
   */
  published: ReadonlySet<string> = new Set(),
  { report = false }: ScanOptions = {},
): Promise<{ local: Candidate[]; undeclared: Candidate[] }> {
  const claimed = claimedPaths(roots, lock);
  const found = new Map<string, Candidate>();

  for (const { target, root, kind, mapping } of kindDirs(roots, targetTable, targets, report)) {
    const items = await collectKindCandidates(roots, root, target, kind, mapping, claimed, report);
    for (const item of items) {
      const key = `${kind}:${item.name}`;
      const first = found.get(key);
      if (first === undefined) found.set(key, item);
      else first.elsewhere.push({ from: item.from, target: item.target });
    }
  }

  const all = [...found.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  return {
    local: all.filter((item) => !published.has(`${item.kind}:${item.name}`)),
    undeclared: all.filter((item) => published.has(`${item.kind}:${item.name}`)),
  };
}

/** Real paths, so a home or project behind a symlink still matches what the lock says. */
function claimedPaths(roots: Roots, lock: Lock): Set<string> {
  const claimed = new Set<string>();
  for (const entry of Object.values(lock.artifacts)) {
    for (const link of entry.links ?? []) {
      const path = resolve(roots.base, link.path);
      claimed.add(canonical(path));
      // A link whose target is gone does not resolve, so it is also claimed by its own place.
      claimed.add(join(canonical(dirname(path)), basename(path)));
    }
    // A row authored here has no link - the folder it came from is already
    // where the target reads it - so its origin is what marks it as spoken for.
    if (entry.origin !== undefined) {
      claimed.add(canonical(resolve(roots.base, entry.origin.path)));
    }
  }
  return claimed;
}

interface KindDir {
  target: string;
  root: string;
  kind: ArtifactKind;
  mapping: KindMapping & { subdir: string };
}

function kindDirs(
  roots: Roots,
  targetTable: Targets,
  targets: readonly string[],
  report: boolean,
): KindDir[] {
  const dirs: KindDir[] = [];
  for (const name of targets) {
    const target = targetTable[name];
    if (target === undefined) continue;
    const root = targetRoot(target, roots.scope, roots.cwd);
    // `SCANNED_KINDS`, not every kind: a target may keep plugins and skills in
    // one folder, so walking both would report every skill twice.
    for (const kind of SCANNED_KINDS) {
      const mapping = target.kinds[kind];
      if (mapping?.subdir === undefined) continue;
      // A file in the target's own format cannot be published as it is.
      if (mapping.codec !== undefined && !report) continue;
      dirs.push({ target: name, root, kind, mapping: mapping as KindDir["mapping"] });
    }
  }
  return dirs;
}

/** Everything of one kind sitting in a target directory that is neither claimed nor assembled by us. */
async function collectKindCandidates(
  roots: Roots,
  root: string,
  targetName: string,
  kind: ArtifactKind,
  mapping: KindMapping & { subdir: string },
  claimed: ReadonlySet<string>,
  followLinks: boolean,
): Promise<Candidate[]> {
  const dir = join(root, mapping.subdir);

  let listing: string[];
  try {
    listing = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  if (listing.length === 0) return [];

  const entries = await entriesIn(
    root,
    dir,
    {
      kind,
      shape: mapping.shape,
      extensions: mapping.extension === undefined ? [] : [mapping.extension],
      ...entryOf(kind),
    },
    undefined,
    { followLinks },
  );

  const store = canonical(roots.artifacts);
  const found: Candidate[] = [];
  for (const entry of entries) {
    const full = join(root, ...entry.path.split(posix.sep));
    const real = canonical(full);
    // A followed link into the staged tree is ours, whether or not the lock still names it.
    if (claimed.has(real) || isWithin(store, real)) continue;
    if (await holdsStagedLink(roots, full)) continue;

    found.push({
      name: entry.name,
      kind,
      from: full,
      target: targetName,
      suggestedPath: registryPath(kind, entry.name, full),
      description: entry.description,
      elsewhere: [],
    });
  }
  return found;
}

/**
 * A report lists everything a target loads, links of yours and files in its own
 * format included; adoption reads only what it could publish.
 */
interface ScanOptions {
  report?: boolean;
}

/** The kind's own entry file, where it declares one; a target lays out the rest. */
function entryOf(kind: ArtifactKind): { entry?: string } {
  const entry = KIND_SPECS[kind].entry;
  return entry === undefined ? {} : { entry };
}

/**
 * A directory we assembled rather than one a person wrote: a namespace is
 * projected as a directory of links into this scope's own tree.
 */
async function holdsStagedLink(roots: Roots, full: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(full);
  } catch {
    return false;
  }
  for (const name of names) {
    const { target } = await inspect(join(full, name));
    if (target !== undefined && isWithin(resolve(roots.artifacts), resolve(target))) return true;
  }
  return false;
}

/** Links of yours in a target folder that point at nothing, so the target cannot load them. */
export async function danglingLinks(
  roots: Roots,
  targetTable: Targets,
  targets: readonly string[],
  lock: Lock,
): Promise<DanglingLink[]> {
  const claimed = claimedPaths(roots, lock);
  const store = canonical(roots.artifacts);
  const seen = new Set<string>();
  const found: DanglingLink[] = [];
  for (const { target, root, mapping } of kindDirs(roots, targetTable, targets, true)) {
    const dir = join(root, mapping.subdir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || !item.isSymbolicLink()) continue;
      const path = join(dir, item.name);
      // One aireg made is an installed artifact's `missing`, which status already says.
      if (claimed.has(join(canonical(dir), item.name)) || (await reachable(path))) continue;
      const points = await readlink(path).catch(() => undefined);
      if (points === undefined || isWithin(store, resolve(canonical(dir), points))) continue;
      found.push({ path, linksTo: points, target });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DanglingLink {
  path: string;
  /** What the link names, as written. */
  linksTo: string;
  target: string;
}

async function reachable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Relative and POSIX, for reporting where inside the project it sits. */
export function displayPath(roots: Roots, path: string): string {
  return posixRelative(roots.base, path);
}
