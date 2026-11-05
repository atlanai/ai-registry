import type { ArtifactKind } from "#adapter/kinds.ts";
import { list } from "#adapter/text.ts";
import { askingFor, type Pinnable } from "#core/manifest/match.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { LinkState } from "#core/plan/status.ts";
import type { Targets } from "#core/target/contract.ts";
import { DEFAULT_TARGETS, names } from "#core/target/ids.ts";
import { readsFor } from "#core/target/placement.ts";

/** A target by the name a person picks it by: a tool's own name, or a shared folder's path. */
export function toolName(targetTable: Targets | undefined, name: string): string {
  const target = targetTable?.[name];
  if (target === undefined) return name;
  return target.shared ? target.projectRoot : target.displayName;
}

/** The chosen targets that read these folders, then any unchosen tool whose own folder holds it. */
export function loadedBy(
  targetTable: Targets,
  chosen: readonly string[],
  kind: ArtifactKind | undefined,
  folders: readonly string[],
): string[] {
  const picked = chosen.filter((tool) => loads(targetTable, tool, kind, folders));
  const others = folders.filter(
    (folder) => !picked.includes(folder) && targetTable[folder]?.shared === false,
  );
  // A shared folder none of them reads is still where the artifact went.
  const unread = folders.filter(
    (folder) =>
      targetTable[folder]?.shared === true &&
      !picked.some((tool) => tool === folder || loads(targetTable, tool, kind, [folder])),
  );
  return [...picked, ...others, ...unread];
}

function loads(
  targetTable: Targets,
  tool: string,
  kind: ArtifactKind | undefined,
  folders: readonly string[],
): boolean {
  if (folders.includes(tool)) return true;
  return (
    kind !== undefined && readsFor(targetTable, tool, kind).some((read) => folders.includes(read))
  );
}

/** The targets a scope installs for, read without refusing a name this aireg does not know. */
export function scopeTargets(manifest: Manifest, targetTable: Targets): string[] {
  const wanted = manifest.targets.length > 0 ? manifest.targets : DEFAULT_TARGETS;
  return wanted.includes("*") ? names(targetTable) : [...wanted];
}

/** Each entry's own targets, or the scope's for an entry naming none or a row only others need. */
export function chosenFor(manifest: Manifest, scope: readonly string[], row: Pinnable): string[] {
  const asking = askingFor(manifest, row);
  if (asking.length === 0) return [...scope];
  return [...new Set(asking.flatMap((ref) => ref.targets ?? scope))];
}

/** The target's own folder first, then the first folder it reads this kind from. */
export function stateFor(
  targetTable: Targets,
  tool: string,
  kind: ArtifactKind | undefined,
  states: Readonly<Record<string, LinkState>>,
): LinkState | undefined {
  const own = states[tool];
  if (own !== undefined) return own;
  const read =
    kind === undefined
      ? undefined
      : readsFor(targetTable, tool, kind).find((folder) => states[folder] !== undefined);
  return read === undefined ? undefined : states[read];
}

export function linkLoadedBy(
  targetTable: Targets,
  chosen: readonly string[],
  kind: ArtifactKind | undefined,
  folder: string,
): string {
  return loadedBy(targetTable, chosen, kind, [folder])
    .map((name) => toolName(targetTable, name))
    .join(", ");
}

export function unhandled(
  targetTable: Targets,
  name: string,
  kinds: readonly ArtifactKind[],
): ArtifactKind[] {
  const target = targetTable[name];
  if (target === undefined) return [];
  return kinds.filter((kind) => target.kinds[kind] === undefined);
}

export function skipLine(
  targetTable: Targets,
  tool: string,
  names: readonly string[],
  kinds: readonly ArtifactKind[],
): string {
  const reason = unhandled(targetTable, tool, kinds);
  const because =
    reason.length === 0 ? "" : `: it does not load ${list(reason.map((kind) => `${kind}s`))}`;
  return `${toolName(targetTable, tool)} skips ${list(names)}${because}.`;
}
