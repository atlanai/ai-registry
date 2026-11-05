import { resolve } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Target, Targets } from "./contract.ts";
import { targetRoot } from "./roots.ts";

/** The folders a target reads a kind from, most preferred first. */
export function readsFor(
  targetTable: Targets,
  name: string,
  kind: ArtifactKind,
  scope?: Scope,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const target = targetTable[name];
  if (target === undefined) return [];
  const reads = target.reads[kind] ?? (target.kinds[kind] === undefined ? [] : [name]);
  // A summary passes no scope; a project's shared folder still counts as the target's own there.
  const shared = sharedOwnFolder(targetTable, target, kind, scope ?? "project", env);
  return shared === undefined
    ? reads
    : [...new Set(reads.map((read) => (read === name ? shared : read)))];
}

/** The shared folder that is this target's own folder for a kind in this scope, by its target. */
function sharedOwnFolder(
  targetTable: Targets,
  target: Target,
  kind: ArtifactKind,
  scope: Scope,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const own = target.kinds[kind];
  if (target.shared || own === undefined || !placeable(target, kind, scope)) return undefined;
  const root = (each: Target) =>
    scope === "project" ? each.projectRoot : targetRoot(each, "user", "", env);
  return Object.values(targetTable).find((other) => {
    const theirs = other.kinds[kind];
    return (
      other.shared &&
      theirs !== undefined &&
      placeable(other, kind, scope) &&
      theirs.shape === own.shape &&
      theirs.subdir === own.subdir &&
      theirs.extension === own.extension &&
      resolve(root(other)) === resolve(root(target))
    );
  })?.name;
}

function placeable(target: Target | undefined, kind: ArtifactKind, scope: Scope): boolean {
  const mapping = target?.kinds[kind];
  return mapping !== undefined && (mapping.scope === undefined || mapping.scope === scope);
}

export interface KindTargets {
  /** Folders to write, each named by the target that lays it out. */
  targets: string[];
  /** Selected targets that read this kind from nowhere at this scope. */
  unreadable: string[];
}

/**
 * The fewest folders reaching every selected target that reads this kind, so a shared one is
 * written once. `wrapped` items sit in plugin folders, which another tool cannot read through.
 */
export function placementFor(
  kind: ArtifactKind,
  selected: readonly string[],
  targetTable: Targets,
  scope: Scope,
  wrapped = false,
  env: NodeJS.ProcessEnv = process.env,
): KindTargets {
  const needs: string[][] = [];
  const unreadable: string[] = [];
  for (const name of new Set(selected)) {
    if (targetTable[name] === undefined) continue;
    // Another tool's plugin folder nests each item a level deeper than this one looks.
    const reads = readsFor(targetTable, name, kind, scope, env).filter(
      (read) =>
        placeable(targetTable[read], kind, scope) &&
        (read === name || !wrapped || !takesPlugin(targetTable[read] as Target, scope)),
    );
    if (reads.length === 0) unreadable.push(name);
    else needs.push(reads);
  }

  // Shared folders first, then each tool's own preference, then the name.
  const coverage = new Map<string, number>();
  const rank = new Map<string, number>();
  for (const reads of needs) {
    reads.forEach((read, index) => {
      coverage.set(read, (coverage.get(read) ?? 0) + 1);
      rank.set(read, Math.min(rank.get(read) ?? index, index));
    });
  }
  const candidates = [...coverage.keys()].sort(
    (a, b) =>
      (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0) ||
      (rank.get(a) ?? 0) - (rank.get(b) ?? 0) ||
      a.localeCompare(b),
  );
  const covers = (chosen: readonly string[]) =>
    needs.every((reads) => reads.some((read) => chosen.includes(read)));

  // Exact for the handful of folders a machine has; greedy past that.
  if (candidates.length <= 12) {
    for (let size = 1; size <= candidates.length; size++) {
      for (const chosen of combinations(candidates, size)) {
        if (covers(chosen)) return { targets: chosen, unreadable };
      }
    }
  }
  const chosen: string[] = [];
  for (const reads of needs) {
    if (!reads.some((read) => chosen.includes(read))) chosen.push(reads[0] as string);
  }
  return { targets: chosen, unreadable };
}

function* combinations(items: readonly string[], size: number, start = 0): Generator<string[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let index = start; index <= items.length - size; index++) {
    for (const rest of combinations(items, size - 1, index + 1)) {
      yield [items[index] as string, ...rest];
    }
  }
}

/** Every folder the selected targets read, for finding what already sits in them. */
export function readTargets(selected: readonly string[], targetTable: Targets): string[] {
  const out = new Set<string>();
  for (const name of selected) {
    if (targetTable[name] === undefined) continue;
    out.add(name);
    for (const reads of Object.values(targetTable[name].reads)) {
      for (const read of reads) if (targetTable[read] !== undefined) out.add(read);
    }
  }
  return [...out];
}

/** The command a person runs before this target loads a kind placed at `scope`, if any. */
export function trustFor(target: Target, kind: ArtifactKind, scope: Scope): string | undefined {
  const trust = target.trust[kind];
  return trust === undefined || (trust.scope ?? scope) !== scope ? undefined : trust.run;
}

/** True when this target loads a directory of artifacts as one plugin. */
export function takesPlugin(target: Target, scope: Scope = "user"): boolean {
  const mapping = target.kinds.plugin;
  if (mapping === undefined || mapping.shape !== "directory" || mapping.subdir === undefined) {
    return false;
  }
  // A kind pinned to one scope is not placed in the others at all.
  return mapping.scope === undefined || mapping.scope === scope;
}
