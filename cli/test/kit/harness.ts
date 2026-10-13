import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Harnesses } from "#core/harness/index.ts";
import { type ArtifactKind, KIND_SPECS } from "#core/kinds.ts";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";

/** Which harnesses a machine has varies, so every root the CLI may write is searched. */
export const HARNESS_ROOTS: readonly string[] = BUILTIN_HARNESSES.map(
  (harness) => harness.roots.project,
);

/** The table with one harness given no place for a kind, as a harness without that kind is. */
export function withoutKind(harnesses: Harnesses, name: string, kind: ArtifactKind): Harnesses {
  const target = harnesses[name];
  if (target === undefined) return harnesses;
  const { [kind]: _dropped, ...kinds } = target.kinds;
  return { ...harnesses, [name]: { ...target, kinds } };
}

/**
 * Where a skill is projected under `root`: inside the plugin its namespace
 * becomes, or directly when the harness has no plugin container.
 */
export function projected(root: string, name: string): string {
  const entry = KIND_SPECS.skill.entry as string;
  for (const harness of HARNESS_ROOTS) {
    const base = join(root, harness, KIND_SPECS.skill.dir);
    if (!existsSync(base)) continue;
    const direct = join(base, name, entry);
    if (existsSync(direct)) return direct;
    for (const namespace of readdirSync(base)) {
      // A namespace is projected as a directory of its artifacts, and as an
      // assembled plugin where the harness reads one.
      for (const inside of [
        join(base, namespace, name, entry),
        join(base, namespace, KIND_SPECS.skill.dir, name, entry),
      ]) {
        if (existsSync(inside)) return inside;
      }
    }
  }
  throw new Error(`${name} is not projected under ${root}`);
}
