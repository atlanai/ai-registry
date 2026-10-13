import { readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { canonical } from "#core/fs/canonical.ts";
import { inspect } from "#core/fs/link.ts";
import { posixRelative } from "#core/fs/path.ts";
import { type Harnesses, type KindMapping, targetRoot } from "#core/harness/index.ts";
import { type ArtifactKind, KIND_SPECS, SCANNED_KINDS } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { entriesIn } from "#core/sync/scan.ts";

export interface Candidate {
  name: string;
  kind: ArtifactKind;
  /** Absolute path to the content a person wrote. */
  from: string;
  /** Harness it was found in, so a report can say where. */
  target: string;
  /** Where it would sit in a registry laid out the standard way. */
  suggestedPath: string;
  description: string | undefined;
  /** The same artifact in the other harness directories, which a report names once. */
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

/** The kind's own entry file, where it declares one; a harness lays out the rest. */
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

/** Everything of one kind sitting in a harness directory that is neither claimed nor assembled by us. */
async function collectKindCandidates(
  roots: Roots,
  root: string,
  targetName: string,
  kind: ArtifactKind,
  mapping: KindMapping & { subdir: string },
  claimed: ReadonlySet<string>,
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
  );

  const found: Candidate[] = [];
  for (const entry of entries) {
    const full = join(root, ...entry.path.split(posix.sep));
    if (claimed.has(canonical(full))) continue;
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
 * The reverse of projection: anything in a harness directory that is not a link
 * into this scope's own trees, and that the lock does not claim, is local work.
 */
export async function candidates(
  roots: Roots,
  harnesses: Harnesses,
  targets: readonly string[],
  lock: Lock,
  /**
   * `kind:name` for everything the registries publish. A name they already
   * publish is not local work; it is an artifact this project has not declared.
   */
  published: ReadonlySet<string> = new Set(),
): Promise<{ local: Candidate[]; undeclared: Candidate[] }> {
  // Real paths, so a home or project behind a symlink still matches what the lock says.
  const claimed = new Set<string>();
  for (const entry of Object.values(lock.artifacts)) {
    for (const link of entry.links ?? []) claimed.add(canonical(resolve(roots.base, link.path)));
    // A row authored here has no link - the folder it came from is already
    // where the harness reads it - so its origin is what marks it as spoken for.
    if (entry.origin !== undefined) {
      claimed.add(canonical(resolve(roots.base, entry.origin.path)));
    }
  }

  const found = new Map<string, Candidate>();

  for (const name of targets) {
    const target = harnesses[name];
    if (target === undefined) continue;
    const root = targetRoot(target, roots.scope, roots.cwd);

    // `SCANNED_KINDS`, not every kind: a harness may keep plugins and skills in
    // one folder, so walking both would report every skill twice.
    for (const kind of SCANNED_KINDS) {
      const mapping = target.kinds[kind];
      // A rendered file is aireg's own output, not an artifact to read back.
      if (mapping?.subdir === undefined || mapping.render !== undefined) continue;

      const items = await collectKindCandidates(
        roots,
        root,
        name,
        kind,
        mapping as KindMapping & { subdir: string },
        claimed,
      );
      for (const item of items) {
        const key = `${kind}:${item.name}`;
        const first = found.get(key);
        if (first === undefined) found.set(key, item);
        else first.elsewhere.push({ from: item.from, target: item.target });
      }
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

/** Relative and POSIX, for reporting where inside the project it sits. */
export function displayPath(roots: Roots, path: string): string {
  return posixRelative(roots.base, path);
}
