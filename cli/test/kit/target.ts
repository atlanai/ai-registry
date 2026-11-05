import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { type KindSpec, kindSpec } from "#core/kinds.ts";
import type { Targets } from "#core/target/contract.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";

/** Which targets a machine has varies, so every root the CLI may write is searched. */
export const TARGET_ROOTS: readonly string[] = BUILTIN_TARGETS.map(
  (target) => target.roots.project,
);

/** The table with one target given no place for a kind, as a target without that kind is. */
export function withoutKind(targetTable: Targets, name: string, kind: ArtifactKind): Targets {
  const target = targetTable[name];
  if (target === undefined) return targetTable;
  const { [kind]: _dropped, ...kinds } = target.kinds;
  return { ...targetTable, [name]: { ...target, kinds } };
}

/** Inside the plugin its namespace becomes, or directly when the target has no plugins. */
export function projected(root: string, name: string): string {
  const skill = kindSpec("skill") as KindSpec;
  const entry = skill.entry as string;
  for (const target of TARGET_ROOTS) {
    const base = join(root, target, skill.dir);
    if (!existsSync(base)) continue;
    const direct = join(base, name, entry);
    if (existsSync(direct)) return direct;
    for (const namespace of readdirSync(base)) {
      // A namespace is projected as a directory of its artifacts, and as an
      // assembled plugin where the target reads one.
      for (const inside of [
        join(base, namespace, name, entry),
        join(base, namespace, skill.dir, name, entry),
      ]) {
        if (existsSync(inside)) return inside;
      }
    }
  }
  throw new Error(`${name} is not projected under ${root}`);
}
