import type { ArtifactGroup, ArtifactRow, ArtifactState } from "./model.ts";

export type Line =
  | { kind: "group"; group: ArtifactGroup }
  | { kind: "artifact"; group: ArtifactGroup; row: ArtifactRow };

export interface FlattenOptions {
  folded: ReadonlySet<string>;
  /** Case-insensitive substring of the key, state, group label, namespace or version. */
  filter: string;
  /** When set, only rows in this state survive. */
  only: ArtifactState | undefined;
}

/**
 * Groups and their members as one list of lines, kept out of the view so key
 * handling and rendering agree by construction.
 */
export function flatten(
  groups: readonly ArtifactGroup[],
  options: FlattenOptions,
): { lines: Line[]; shown: number } {
  const lines: Line[] = [];
  let shown = 0;
  const filtering = options.filter.trim() !== "" || options.only !== undefined;
  for (const group of groups) {
    const members = group.rows.filter((row) => keep(row, group, options));
    // A filter that matches nothing in a group hides the group: the list is
    // then a list of hits, not a list of groups with a gap where hits were.
    if (filtering && members.length === 0) continue;
    lines.push({ kind: "group", group });
    shown += members.length;
    if (options.folded.has(group.key) && !filtering) continue;
    for (const row of members) lines.push({ kind: "artifact", group, row });
  }
  return { lines, shown };
}

function keep(row: ArtifactRow, group: ArtifactGroup, options: FlattenOptions): boolean {
  if (options.only !== undefined && row.state !== options.only) return false;
  const needle = options.filter.trim().toLowerCase();
  if (needle === "") return true;
  // The group's label too: work authored here has no namespace, and "this
  // machine" is the only name a person has for it.
  return (
    row.key.toLowerCase().includes(needle) ||
    row.state.includes(needle) ||
    group.label.toLowerCase().includes(needle) ||
    (row.namespace ?? "").toLowerCase().includes(needle) ||
    (row.version ?? "").includes(needle)
  );
}

export function lineKey(line: Line): string {
  return line.kind === "group" ? `g:${line.group.key}` : `a:${line.row.key}`;
}
