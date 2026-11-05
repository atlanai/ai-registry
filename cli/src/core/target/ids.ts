import { BUILTIN_TARGETS } from "#targets/index.ts";
import type { EarlierTarget, TargetCategory, Targets } from "./contract.ts";

/** The tools a manifest installs into when it names none, in the order they are listed. */
export const DEFAULT_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.default === true,
).map((target) => target.id);

/** The targets whose folders hold artifacts worth importing, by name. */
export const IMPORTABLE_TARGETS: readonly string[] = BUILTIN_TARGETS.filter(
  (target) => target.importable === true,
)
  .map((target) => target.id)
  .sort();

/**
 * The id aireg 0.1 knew a built-in by (its first alias, profile kept), else `id` as given; never
 * an alias the table no longer reads as this target, which the next command could not resolve.
 */
export function earlierId(targetTable: Targets, id: string): string {
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const was = BUILTIN_TARGETS.find((target) => target.id === base)?.aliases?.[0];
  if (was === undefined || canonicalId(targetTable, was) !== base) return id;
  return at === -1 ? was : `${was}${id.slice(at)}`;
}

const EARLIER_KINDS = {
  "coding-agent": "coding",
  "personal-agent": "personal",
  "shared-folder": "shared",
} as const satisfies Record<TargetCategory, EarlierTarget["kind"]>;

/** A record keyed by target id, keyed instead by `earlierId`. */
export function byEarlierIds<T>(targetTable: Targets, byId: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(byId).map(([id, value]) => [earlierId(targetTable, id), value]),
  );
}

/** The table keyed and named by `earlierId`, for adapters built against aireg 0.1. */
export function earlierTable(targetTable: Targets): Record<string, EarlierTarget> {
  const out: Record<string, EarlierTarget> = {};
  for (const target of Object.values(targetTable)) {
    const name = earlierId(targetTable, target.name);
    const reads = Object.fromEntries(
      Object.entries(target.reads).map(([kind, ids]) => [
        kind,
        ids.map((read) => earlierId(targetTable, read)),
      ]),
    );
    out[name] = { ...target, name, reads, kind: EARLIER_KINDS[target.category] };
  }
  return out;
}

/** The id an id or one of its aliases names, `<alias>:<profile>` included; any other as given. */
export function canonicalId(targetTable: Targets, id: string): string {
  if (Object.hasOwn(targetTable, id)) return id;
  const at = id.indexOf(":");
  const base = at === -1 ? id : id.slice(0, at);
  const owner = Object.values(targetTable).find((target) => target.aliases.includes(base));
  if (owner === undefined) return id;
  return at === -1 ? owner.name : `${owner.name}${id.slice(at)}`;
}

/** Each as its canonical id, once, in the order given. */
export function canonicalIds(targetTable: Targets, ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => canonicalId(targetTable, id)))];
}

export function names(targetTable: Targets): string[] {
  return Object.keys(targetTable).sort();
}
