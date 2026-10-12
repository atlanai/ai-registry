import { list } from "#adapter/text.ts";
import { type Harnesses, readsFor } from "#core/harness/index.ts";
import type { ArtifactKind } from "#core/kinds.ts";

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

/** One line per shared folder and kind: which tools read that kind from it. */
export function sharedReads(harnesses: Harnesses): string[] {
  const shared = Object.values(harnesses).filter((target) => target.shared);
  const tools = Object.values(harnesses).filter((target) => !target.shared);
  return shared.flatMap((folder) =>
    [...new Set(tools.flatMap((tool) => Object.keys(tool.reads)))].sort().flatMap((kind) => {
      const readers = tools.filter((tool) =>
        tool.reads[kind as ArtifactKind]?.includes(folder.name),
      );
      return readers.length === 0
        ? []
        : [
            `${list(readers.map((tool) => tool.displayName))} read ${kind}s from the shared ${folder.projectRoot} folder.`,
          ];
    }),
  );
}
