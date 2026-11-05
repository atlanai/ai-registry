import type { Dirent } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { ifReadable } from "#adapter/files.ts";
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
  /** Absolute. */
  from: string;
  target: string;
  /** Where a standard registry layout would file it. */
  suggestedPath: string;
  description: string | undefined;
  /** The same artifact in other target directories, which a report names once. */
  elsewhere: { from: string; target: string }[];
}

/** The scanner's table read in reverse, so a scan finds the result again. */
export function registryPath(kind: ArtifactKind, name: string, from: string): string {
  const spec = KIND_SPECS[kind];
  if (spec.shape === "directory") return posix.join(spec.dir, name);
  const dot = from.lastIndexOf(".");
  const extension = dot > 0 ? from.slice(dot) : (spec.extensions[0] ?? "");
  return posix.join(spec.dir, `${name}${extension}`);
}

/** Anything in a target directory that is not our link and not in the lock is local work. */
export async function candidates(
  roots: Roots,
  targetTable: Targets,
  targets: readonly string[],
  lock: Lock,
  /** `kind:name` the registries publish: such a name is undeclared, not local work. */
  published: ReadonlySet<string> = new Set(),
  { report = false }: ScanOptions = {},
): Promise<{ local: Candidate[]; undeclared: Candidate[] }> {
  const claimed = claimedPaths(roots, lock);
  const found = new Map<string, Candidate>();

  for (const dir of kindDirs(roots, targetTable, targets, report)) {
    const items = await collectKindCandidates({ ...dir, roots, claimed, followLinks: report });
    for (const item of items) {
      const key = `${dir.kind}:${item.name}`;
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
    // A row authored here has no link, since the target reads its folder, so its origin claims it.
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
    const root = targetRoot(target, { scope: roots.scope, cwd: roots.cwd, env: process.env });
    // A target may keep plugins and skills in one folder; walking both would report skills twice.
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

interface KindScan extends KindDir {
  roots: Roots;
  claimed: ReadonlySet<string>;
  followLinks: boolean;
}

async function collectKindCandidates({
  roots,
  root,
  target,
  kind,
  mapping,
  claimed,
  followLinks,
}: KindScan): Promise<Candidate[]> {
  const dir = join(root, mapping.subdir);

  const listing = (await ifReadable(readdir(dir))) ?? [];
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
      target,
      suggestedPath: registryPath(kind, entry.name, full),
      description: entry.description,
      elsewhere: [],
    });
  }
  return found;
}

/** A report lists everything a target loads; adoption reads only what it could publish. */
interface ScanOptions {
  report?: boolean;
}

function entryOf(kind: ArtifactKind): { entry?: string } {
  const entry = KIND_SPECS[kind].entry;
  return entry === undefined ? {} : { entry };
}

/** A namespace is projected as a directory of links into our tree, so it is ours, not a person's. */
async function holdsStagedLink(roots: Roots, full: string): Promise<boolean> {
  const names = (await ifReadable(readdir(full))) ?? [];
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
    const items: Dirent[] = (await ifReadable(readdir(dir, { withFileTypes: true }))) ?? [];
    for (const item of items) {
      if (item.name.startsWith(".") || !item.isSymbolicLink()) continue;
      const path = join(dir, item.name);
      // One aireg made is an installed artifact's `missing`, which status already says.
      if (claimed.has(join(canonical(dir), item.name)) || (await reachable(path))) continue;
      const points = await ifReadable(readlink(path));
      if (points === undefined || isWithin(store, resolve(canonical(dir), points))) continue;
      found.push({ path, linksTo: points, target });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DanglingLink {
  path: string;
  /** As written. */
  linksTo: string;
  target: string;
}

async function reachable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Gone, looping or unreadable: the target cannot load it either.
    return false;
  }
}

export function displayPath(roots: Roots, path: string): string {
  return posixRelative(roots.base, path);
}
