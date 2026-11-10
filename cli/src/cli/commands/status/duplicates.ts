import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONCURRENCY, limiter } from "#adapter/concurrency.ts";
import { ENVELOPE } from "#adapter/filespec/names.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { byCodeUnit } from "#adapter/text.ts";
import { withName } from "#core/frontmatter.ts";
import { authored } from "#core/fs/tree.ts";

export interface Copy {
  name: string;
  /** The real folder, never a link to it. */
  path: string;
  /** Set when installed: the registry it came from. */
  registry?: string;
}

export interface Duplicate {
  /** `identical`: the same files. `name`: unmanaged skills of one name whose files differ. */
  match: "identical" | "name";
  artifacts: Copy[];
}

/**
 * Report only. Installed skills join only identical matches: installing already refuses
 * two artifacts of one name in a target folder.
 */
export async function duplicates(
  installed: readonly Copy[],
  unmanaged: readonly Copy[],
): Promise<Duplicate[]> {
  const all = [...installed, ...unmanaged];
  // Each key reads every file of a skill; hundreds at once would run out of descriptors.
  const bounded = limiter(CONCURRENCY);
  const keys = await Promise.all(all.map((copy) => bounded(() => contentKey(copy.path))));
  const keyOf = new Map(all.map((copy, at) => [copy, keys[at]]));
  const identical = groupBy(all, (copy) => keyOf.get(copy) ?? copy.path);
  const named = groupBy(unmanaged, (copy) => copy.name).filter(
    (group) => new Set(group.map((copy) => keyOf.get(copy))).size > 1,
  );
  return [
    ...identical.map((artifacts) => ({ match: "identical" as const, artifacts })),
    ...named.map((artifacts) => ({ match: "name" as const, artifacts })),
  ];
}

/**
 * Each file's path, length and text, so two different folders never share a key. Line endings
 * and SKILL.md's `name` are left out, since a copy that differs only in those is still a copy.
 */
async function contentKey(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await authored(dir)).files) {
    if (file.path === ENVELOPE) continue;
    // Latin-1 reads each byte as one character, so any file reads the same way twice.
    let text = (await readFile(join(dir, file.path), "latin1")).replaceAll("\r\n", "\n");
    if (file.path === SKILL_ENTRY) text = withName(text, "");
    hash.update(`${file.path}\0${text.length}\0`).update(text, "latin1");
  }
  return hash.digest("hex");
}

/** Groups of two or more, each sorted, in the order of their first copy. */
function groupBy(copies: readonly Copy[], key: (copy: Copy) => string): Copy[][] {
  const groups = new Map<string, Copy[]>();
  for (const copy of copies) groups.set(key(copy), [...(groups.get(key(copy)) ?? []), copy]);
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort(byCopy))
    .sort((a, b) => byCopy(a[0] as Copy, b[0] as Copy));
}

function byCopy(a: Copy, b: Copy): number {
  return byCodeUnit(a.name, b.name) || byCodeUnit(a.path, b.path);
}
