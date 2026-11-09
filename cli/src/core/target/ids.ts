import { BUILTIN_TARGETS } from "#targets/index.ts";
import {
  type EarlierTarget,
  TARGET_CATEGORIES,
  type TargetCategory,
  type Targets,
} from "./contract.ts";

/** Used when a manifest names none. */
export const DEFAULT_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.default === true,
).map((target) => target.id);

export const IMPORTABLE_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.importable === true,
)
  .map((target) => target.id)
  .sort();

/**
 * The id aireg 0.1 knew a built-in by (its first alias, profile kept); never an alias the table
 * no longer resolves here, so a writer never records an id the next command cannot resolve.
 */
export function earlierId(targetTable: Targets, id: string): string {
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const was = BUILTIN_TARGETS.find((target) => target.id === base)?.aliases?.[0];
  if (was === undefined || canonicalId(targetTable, was) !== base) return id;
  return at === -1 ? was : `${was}${id.slice(at)}`;
}

/** aireg 0.1's name for each category, still read as `kind`. */
const EARLIER_KINDS = {
  "coding-agent": "coding",
  "personal-agent": "personal",
  "shared-folder": "shared",
} as const satisfies Record<TargetCategory, EarlierTarget["kind"]>;

export function categoryOfEarlier(kind: string): TargetCategory | undefined {
  return TARGET_CATEGORIES.find((category) => EARLIER_KINDS[category] === kind);
}

export function byEarlierIds<T>(targetTable: Targets, byId: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(byId).map(([id, value]) => [earlierId(targetTable, id), value]),
  );
}

/** For adapters built against aireg 0.1. */
export function earlierTable(targetTable: Targets): Record<string, EarlierTarget> {
  const out: Record<string, EarlierTarget> = {};
  for (const target of Object.values(targetTable)) {
    const name = earlierId(targetTable, target.name);
    const reads = Object.fromEntries(
      Object.entries(target.reads).map(([kind, ids]) => [
        kind,
        (ids ?? []).map((read) => earlierId(targetTable, read)),
      ]),
    );
    out[name] = { ...target, name, reads, kind: EARLIER_KINDS[target.category] };
  }
  return out;
}

/** Resolves aliases, `<alias>:<profile>` included; an unknown id is returned as given. */
export function canonicalId(targetTable: Targets, id: string): string {
  if (Object.hasOwn(targetTable, id)) return id;
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const owner = Object.values(targetTable).find((target) => target.aliases.includes(base));
  if (owner === undefined) return id;
  return at === -1 ? owner.name : `${owner.name}${id.slice(at)}`;
}

export function canonicalIds(targetTable: Targets, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => canonicalId(targetTable, id)))];
}

export function names(targetTable: Targets): string[] {
  return Object.keys(targetTable).sort();
}
