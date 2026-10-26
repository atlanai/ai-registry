import { join } from "node:path";
import { digest } from "#core/fs/digest.ts";
import { type ArtifactKind, kindDir } from "#core/kinds.ts";
import type { Acquired } from "#core/plan/model.ts";
import { assertRemovable, type RemovableRoots, removal } from "#core/plan/removable.ts";
import { moveToBackup } from "#core/store/backups.ts";
import type { Candidate } from "#core/sync/adopt.ts";
import type { Scan } from "./scan.ts";

export interface Copy {
  from: string;
  target: string;
}

/**
 * A folder in a target directory holding an artifact the registry already
 * publishes, as a person who uploaded it before this machine synced it has.
 */
export interface Claim {
  name: string;
  kind: ArtifactKind;
  /** Catalog paths of the registry's artifacts of this kind and name. */
  entries: string[];
  /** Copies holding exactly the registry's bytes: redundant once it is pulled. */
  identical: Copy[];
  /** Copies someone changed, left where they are for a person to decide. */
  different: Copy[];
}

/** Compares against the bytes the scan already staged, so a claim costs no request of its own. */
export async function surveyClaims(
  undeclared: readonly Candidate[],
  acquired: readonly Acquired[],
  registry: string,
): Promise<Claim[]> {
  const source = acquired.find((item) => item.alias === registry);
  if (source === undefined) return [];
  const claims: Claim[] = [];
  for (const candidate of undeclared) {
    const entries = source.catalog.entries.filter(
      (entry) => entry.kind === candidate.kind && entry.name === candidate.name,
    );
    if (entries.length === 0) continue;
    const served = new Set<string>();
    for (const entry of entries) served.add(await digest((await source.content(entry.path)).root));
    const claim: Claim = {
      name: candidate.name,
      kind: candidate.kind,
      entries: entries.map((entry) => entry.path),
      identical: [],
      different: [],
    };
    for (const copy of [
      { from: candidate.from, target: candidate.target },
      ...candidate.elsewhere,
    ]) {
      (served.has(await digest(copy.from)) ? claim.identical : claim.different).push(copy);
    }
    claims.push(claim);
  }
  return claims;
}

/** Filed by target and kind under one run's stamp; a copy reached through a link stays. */
export async function moveAside(
  kind: ArtifactKind,
  name: string,
  copies: readonly Copy[],
  roots: RemovableRoots,
  stamp: string,
): Promise<{ from: string; to: string }[]> {
  const moved: { from: string; to: string }[] = [];
  for (const copy of copies) {
    if (removal(copy.from, roots).how !== "remove") continue;
    await assertRemovable(copy.from, roots);
    const within = join(copy.target, kindDir(kind), name);
    moved.push({ from: copy.from, to: await moveToBackup(copy.from, roots, stamp, within) });
  }
  return moved;
}

/** Plugin-qualified names arrive as `plugin:skill`; the folder is named for the skill. */
function bareName(name: string): string {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  return leaf.slice(leaf.lastIndexOf(":") + 1);
}

/**
 * New registry artifacts a folder of yours already stands in for, so installing would add a
 * second copy. A locked row is yours to keep in step, and the link guard keeps the folder anyway.
 */
export function shadowedByYours(
  scan: Pick<Scan, "items" | "undeclared" | "pinned">,
): ReadonlySet<string> {
  const yours = new Set(scan.undeclared.map((item) => `${item.kind}:${item.name}`));
  const shadowed = new Set<string>();
  for (const item of scan.items) {
    if (item.disposition !== "pull" || scan.pinned.artifacts[item.name] !== undefined) continue;
    if (yours.has(`${item.kind}:${bareName(item.name)}`)) shadowed.add(item.name);
  }
  return shadowed;
}
