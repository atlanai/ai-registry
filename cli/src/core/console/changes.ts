import type { ConsoleState } from "./model.ts";

/** Every artifact's state, by `<group>/<artifact>`, to compare a later read against. */
export function snapshot(state: ConsoleState): Map<string, string> {
  return new Map(
    state.groups.flatMap((group) =>
      group.rows.map((row): [string, string] => [`${group.key}/${row.key}`, row.state]),
    ),
  );
}

/** An exit 0 that changed nothing is worth naming: it is how a refused re-publish looks. */
export function changesSince(before: ReadonlyMap<string, string>, after: ConsoleState): string[] {
  const seen = snapshot(after);
  const name = (key: string) => key.slice(key.indexOf("/") + 1);
  const group = (key: string) => key.slice(0, key.indexOf("/"));
  const gone = [...before.keys()].filter((key) => !seen.has(key));
  const lines: string[] = [];

  for (const [key, state] of seen) {
    const was = before.get(key);
    if (was !== undefined) {
      if (was !== state) lines.push(`${name(key)}: ${was} \u2192 ${state}`);
      continue;
    }
    // Approval moves an artifact from the local group into its namespace, and
    // it keeps its key. Two lines would read as two artifacts.
    const moved = gone.find((old) => name(old) === name(key));
    if (moved !== undefined) {
      gone.splice(gone.indexOf(moved), 1);
      const from = before.get(moved);
      lines.push(`${name(key)}: ${from} in ${group(moved)} \u2192 ${state} in ${group(key)}`);
      continue;
    }
    lines.push(`${name(key)} is now here, ${state}`);
  }
  for (const key of gone) lines.push(`${name(key)} is gone`);
  return lines;
}
