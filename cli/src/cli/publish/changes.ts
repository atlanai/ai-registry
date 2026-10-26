import type { PublishRelationship, Relationship } from "#adapter/index.ts";
import { sanitizeText } from "#adapter/text.ts";

// What a publish changes against the version a registry holds now, so a reviewer sees before it
// is sent which files the registry replaces, archives or gains, and which dependencies move.

/** One file as a version stores it: its path in the artifact, and its digest. */
export interface StoredFile {
  path: string;
  digest: string;
}

/** One version's side of the comparison: its files, and the edges it carries. */
export interface Side {
  files: readonly StoredFile[];
  relationships?: readonly (Relationship | PublishRelationship)[] | undefined;
}

/** Sorted file changes and exact dependency edges added or removed by a publish. */
export interface Changes {
  files: { added: string[]; changed: string[]; removed: string[] };
  dependsOn: { added: string[]; removed: string[] };
}

const sorted = (items: Iterable<string>) => [...items].sort();

function dependsOn(side: Side | undefined): Set<string> {
  const edges = side?.relationships ?? [];
  return new Set(edges.filter((edge) => edge.rel_type === "depends_on").map((edge) => edge.to));
}

/** What `sent` changes against `held`; with no version held, everything it sends is added. */
export function changesFrom(held: Side | undefined, sent: Side): Changes {
  const heldFiles = held?.files ?? [];
  const [entry] = heldFiles;
  const [sole] = sent.files;
  // A sole file on each side is the entry, which a target may name <name>.md and a registry AGENT.md.
  const compared =
    heldFiles.length === 1 && sent.files.length === 1 && entry && sole
      ? [{ path: sole.path, digest: entry.digest }]
      : heldFiles;
  const before = new Map(compared.map((file) => [file.path, file.digest]));
  const after = new Map(sent.files.map((file) => [file.path, file.digest]));
  const was = dependsOn(held);
  const now = dependsOn(sent);
  return {
    files: {
      added: sorted([...after.keys()].filter((path) => !before.has(path))),
      changed: sorted(
        [...after]
          .filter(([path, digest]) => before.has(path) && before.get(path) !== digest)
          .map(([path]) => path),
      ),
      removed: sorted([...before.keys()].filter((path) => !after.has(path))),
    },
    dependsOn: {
      added: sorted([...now].filter((to) => !was.has(to))),
      removed: sorted([...was].filter((to) => !now.has(to))),
    },
  };
}

const SHOWN = 10;

/** Format bounded change details, sanitizing paths and edges supplied by the registry. */
export function changeLines(changes: Changes): string[] {
  const { files, dependsOn: edges } = changes;
  const line = (label: string, what: string) => `    ${label.padEnd(9)}${sanitizeText(what)}`;
  const all = [
    ...files.changed.map((path) => line("changed", path)),
    ...files.removed.map((path) => line("removed", path)),
    ...files.added.map((path) => line("added", path)),
    ...edges.removed.map((to) => line("removed", `depends on ${to}`)),
    ...edges.added.map((to) => line("added", `depends on ${to}`)),
  ];
  if (all.length <= SHOWN) return all;
  const kept = all.slice(0, SHOWN - 1);
  return [...kept, `    and ${all.length - kept.length} more`];
}

/** `filesChanged` and `dependsOnChanged` under `--json`, each left out when it has nothing. */
export function changesJson(changes: Changes | undefined): {
  filesChanged?: Changes["files"];
  dependsOnChanged?: Changes["dependsOn"];
} {
  if (changes === undefined) return {};
  const { files, dependsOn: edges } = changes;
  const anyFile = files.added.length + files.changed.length + files.removed.length > 0;
  const anyEdge = edges.added.length + edges.removed.length > 0;
  return {
    ...(anyFile ? { filesChanged: files } : {}),
    ...(anyEdge ? { dependsOnChanged: edges } : {}),
  };
}
