import { list } from "#adapter/text.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { askingFor, type Manifest, type Pinnable } from "#core/manifest.ts";
import type { LinkState } from "#core/plan/status.ts";
import { DEFAULT_TARGETS, names, readsFor, type Targets } from "#core/target/index.ts";

/** A target by the name a person picks it by: a tool's own name, or a shared folder's path. */
export function toolName(targetTable: Targets | undefined, name: string): string {
  const target = targetTable?.[name];
  if (target === undefined) return name;
  return target.shared ? target.projectRoot : target.displayName;
}

/** Whether a target loads an artifact placed in these folders, its own or one it reads the kind from. */
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

/**
 * The targets that load an artifact placed in these folders: the chosen ones
 * that read them, then any tool whose own folder holds it though it was not chosen.
 */
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

/** The targets a scope installs for, read without refusing a name this aireg does not know. */
export function scopeTargets(manifest: Manifest, targetTable: Targets): string[] {
  const wanted = manifest.targets.length > 0 ? manifest.targets : DEFAULT_TARGETS;
  return wanted.includes("*") ? names(targetTable) : [...wanted];
}

/**
 * The targets a scope installs a row for: those of each manifest entry that
 * asks for it, the scope's own for an entry that names none or for a row only
 * something else needs.
 */
export function chosenFor(manifest: Manifest, scope: readonly string[], row: Pinnable): string[] {
  const asking = askingFor(manifest, row);
  if (asking.length === 0) return [...scope];
  return [...new Set(asking.flatMap((ref) => ref.targets ?? scope))];
}

/**
 * How a target has an artifact, from the state of each folder it was linked in:
 * the target's own folder first, then the first folder it reads this kind from.
 */
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

/** The targets that load what one link places, by name, for a table cell or a step line. */
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

/** The kinds a target cannot load, which explain why it was left out. */
export function unhandled(
  targetTable: Targets,
  name: string,
  kinds: readonly ArtifactKind[],
): ArtifactKind[] {
  const target = targetTable[name];
  if (target === undefined) return [];
  return kinds.filter((kind) => target.kinds[kind] === undefined);
}

/** `Codex skips reviewer: it does not load agents.`, said the same by the plan and by status. */
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
