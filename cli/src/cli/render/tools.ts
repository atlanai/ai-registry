import { list } from "#adapter/text.ts";
import { DEFAULT_TARGETS, type Harnesses, names, readsFor } from "#core/harness/index.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { askingFor, type Manifest, type Pinnable } from "#core/manifest.ts";
import type { LinkState } from "#core/plan/status.ts";

/** A harness by the name a person picks it by: a tool's own name, or a shared folder's path. */
export function toolName(harnesses: Harnesses | undefined, name: string): string {
  const target = harnesses?.[name];
  if (target === undefined) return name;
  return target.shared ? target.projectRoot : target.displayName;
}

/** Whether a harness loads an artifact placed in these folders, its own or one it reads the kind from. */
function loads(
  harnesses: Harnesses,
  tool: string,
  kind: ArtifactKind | undefined,
  folders: readonly string[],
): boolean {
  if (folders.includes(tool)) return true;
  return (
    kind !== undefined && readsFor(harnesses, tool, kind).some((read) => folders.includes(read))
  );
}

/**
 * The harnesses that load an artifact placed in these folders: the chosen ones
 * that read them, then any tool whose own folder holds it though it was not chosen.
 */
export function loadedBy(
  harnesses: Harnesses,
  chosen: readonly string[],
  kind: ArtifactKind | undefined,
  folders: readonly string[],
): string[] {
  const picked = chosen.filter((tool) => loads(harnesses, tool, kind, folders));
  const others = folders.filter(
    (folder) => !picked.includes(folder) && harnesses[folder]?.shared === false,
  );
  // A shared folder none of them reads is still where the artifact went.
  const unread = folders.filter(
    (folder) =>
      harnesses[folder]?.shared === true &&
      !picked.some((tool) => tool === folder || loads(harnesses, tool, kind, [folder])),
  );
  return [...picked, ...others, ...unread];
}

/** The harnesses a scope installs for, read without refusing a name this aireg does not know. */
export function scopeTargets(manifest: Manifest, harnesses: Harnesses): string[] {
  const wanted = manifest.targets.length > 0 ? manifest.targets : DEFAULT_TARGETS;
  return wanted.includes("*") ? names(harnesses) : [...wanted];
}

/**
 * The harnesses a scope installs a row for: those of each manifest entry that
 * asks for it, the scope's own for an entry that names none or for a row only
 * something else needs.
 */
export function chosenFor(manifest: Manifest, scope: readonly string[], row: Pinnable): string[] {
  const asking = askingFor(manifest, row);
  if (asking.length === 0) return [...scope];
  return [...new Set(asking.flatMap((ref) => ref.targets ?? scope))];
}

/**
 * How a harness has an artifact, from the state of each folder it was linked in:
 * the harness's own folder first, then the first folder it reads this kind from.
 */
export function stateFor(
  harnesses: Harnesses,
  tool: string,
  kind: ArtifactKind | undefined,
  states: Readonly<Record<string, LinkState>>,
): LinkState | undefined {
  const own = states[tool];
  if (own !== undefined) return own;
  const read =
    kind === undefined
      ? undefined
      : readsFor(harnesses, tool, kind).find((folder) => states[folder] !== undefined);
  return read === undefined ? undefined : states[read];
}

/** The harnesses that load what one link places, by name, for a table cell or a step line. */
export function linkLoadedBy(
  harnesses: Harnesses,
  chosen: readonly string[],
  kind: ArtifactKind | undefined,
  folder: string,
): string {
  return loadedBy(harnesses, chosen, kind, [folder])
    .map((name) => toolName(harnesses, name))
    .join(", ");
}

/** The kinds a harness cannot load, which explain why it was left out. */
export function unhandled(
  harnesses: Harnesses,
  target: string,
  kinds: readonly ArtifactKind[],
): ArtifactKind[] {
  const harness = harnesses[target];
  if (harness === undefined) return [];
  return kinds.filter((kind) => harness.kinds[kind] === undefined);
}

/** `Codex skips reviewer: it does not load agents.`, said the same by the plan and by status. */
export function skipLine(
  harnesses: Harnesses,
  tool: string,
  names: readonly string[],
  kinds: readonly ArtifactKind[],
): string {
  const reason = unhandled(harnesses, tool, kinds);
  const because =
    reason.length === 0 ? "" : `: it does not load ${list(reason.map((kind) => `${kind}s`))}`;
  return `${toolName(harnesses, tool)} skips ${list(names)}${because}.`;
}
