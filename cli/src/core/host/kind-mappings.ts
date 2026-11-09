import { basename } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { KINDS } from "#adapter/kinds.ts";
import { quoted } from "#adapter/text.ts";
import { type KindSpec, kindPlural } from "#core/kinds.ts";
import type { KindMapping, RegisterEntry, Target, Targets } from "#core/target/contract.ts";
import { canonicalId } from "#core/target/ids.ts";
import { mappingProblems } from "#core/target/load.ts";
import { fixedPrefix } from "#core/target/template.ts";

/** Where each target places a declared kind, or the first problem as a phrase. */
export function mappingsOf(
  name: string,
  spec: Omit<KindSpec, "dir">,
  raw: unknown,
  targetTable: Targets,
): Record<string, KindMapping> | string {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return "has `targets` that are not a mapping of target ids";
  const placed: Record<string, KindMapping> = {};
  for (const [given, mapping] of Object.entries(raw)) {
    const id = canonicalId(targetTable, given);
    const target = targetTable[id];
    if (target === undefined || id.includes(":")) {
      return `maps ${quoted(given)}, which is not a target`;
    }
    const problem = mappingProblem(name, spec, mapping, target);
    if (problem !== undefined) return `maps ${id} wrongly: ${problem}`;
    placed[id] = contributed(mapping as KindMapping);
  }
  return placed;
}

function mappingProblem(
  name: string,
  spec: Omit<KindSpec, "dir">,
  mapping: unknown,
  target: Target,
): string | undefined {
  // A plugin's contents are for the built-in kinds alone.
  if (!isRecord(mapping) || (mapping.shape !== "directory" && mapping.shape !== "file")) {
    return "a kind is placed as a directory or a file";
  }
  if (mapping.shape === "directory" && mapping.entry !== undefined && spec.shape !== "file") {
    return "`entry` is for a kind that is one file";
  }
  const [problem] = mappingProblems(name, mapping);
  if (problem !== undefined) return problem.replace(/\.$/, "");
  const checked = mapping as unknown as KindMapping & { subdir: string };
  return placeProblem(checked.subdir, target) ?? registerProblem(checked.register ?? [], target);
}

/** Its own folder in the target, apart from every folder the target keeps a built-in kind in. */
function placeProblem(subdir: string, target: Target): string | undefined {
  const fixed = fixedPrefix(subdir);
  if (fixed.length === 0 || subdir.split("/").some((part) => part === "" || part === ".")) {
    return `its subdir ${quoted(subdir)} is not a folder of its own`;
  }
  for (const kind of KINDS) {
    const own = target.kinds[kind]?.subdir;
    if (own === undefined) continue;
    const taken = fixedPrefix(own);
    if (within(taken, fixed) || within(fixed, taken)) {
      return `its subdir ${quoted(subdir)} is where the target keeps ${kindPlural(kind)}`;
    }
  }
  return undefined;
}

const within = (outer: readonly string[], inner: readonly string[]) =>
  outer.length <= inner.length && outer.every((part, at) => part === inner[at]);

/** A target's own settings, which no declared kind edits. */
const SETTINGS = new Set(["settings.json", "settings.local.json"]);

/** A file the target shares is edited only in a table named for the artifact. */
function registerProblem(entries: readonly RegisterEntry[], target: Target): string | undefined {
  const shared = new Set(
    KINDS.flatMap((kind) => (target.kinds[kind]?.register ?? []).map((entry) => entry.file)),
  );
  for (const entry of entries) {
    if (SETTINGS.has(basename(entry.file))) {
      return `it registers in ${quoted(entry.file)}, the target's own settings`;
    }
    if (!shared.has(entry.file) && basename(entry.file) !== "config.toml") continue;
    const last = entry.at.at(-1) ?? "";
    if (entry.value === undefined || !last.includes("{name}")) {
      return `it edits ${quoted(entry.file)}, which the target shares, outside a table named for each artifact`;
    }
  }
  return undefined;
}

/** What an adapter registers never replaces or deletes what someone else wrote. */
function contributed(mapping: KindMapping): KindMapping {
  const copy = structuredClone(mapping);
  if (copy.register === undefined) return copy;
  copy.register = copy.register.map(({ init: _init, remove: _remove, ...entry }) => ({
    ...entry,
    conflict: "keep" as const,
  })) as RegisterEntry[];
  return copy;
}
