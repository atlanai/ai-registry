import { isArtifactName } from "#adapter/filespec/names.ts";
import type { Artifact } from "#adapter/index.ts";
import { isSafePath } from "#adapter/paths.ts";
import { sanitizeName, sanitizeText } from "#adapter/text.ts";
import { isRecord } from "#core/fields.ts";
import type { Lock } from "#core/lock.ts";
import { carriedIn } from "#core/plan/carries.ts";
import type { Acquired, Placement } from "#core/plan/model.ts";

export function leftOutOf(
  artifact: Artifact,
  leftOut: readonly string[] | undefined,
): Pick<Placement, "leftOut"> {
  const entry = artifact.files[0]?.path;
  return leftOut === undefined || entry === undefined ? {} : { leftOut: { entry, files: leftOut } };
}

/** A commit an adapter reports for one artifact, which the lockfile records and hands back. */
export function revisionOf(artifact: Artifact): Pick<Placement, "revision"> {
  const { revision } = artifact;
  return typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision) ? { revision } : {};
}

/** The manifest a layout reader wrote into a plugin's spec, as text an envelope can hold. */
export function manifestOf(artifact: Artifact): Record<string, unknown> | undefined {
  const text = artifact.envelope.spec?.manifest;
  if (typeof text !== "string") return undefined;
  try {
    const manifest: unknown = JSON.parse(text);
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** A plugin's manifest and command files from its spec, keeping only paths inside the plugin. */
export function pluginOf(artifact: Artifact): Pick<Placement, "plugin"> {
  const spec = artifact.envelope.spec;
  if (artifact.kind !== "plugin" || spec === undefined) return {};
  const manifest = manifestOf(artifact);
  const commands = (Array.isArray(spec.commands) ? spec.commands : []).flatMap((item: unknown) => {
    const { name, path } = (item ?? {}) as { name?: unknown; path?: unknown };
    if (typeof name !== "string" || !isArtifactName(name)) return [];
    return typeof path === "string" && isSafePath(path) && path.endsWith(".md")
      ? [{ name, path }]
      : [];
  });
  const description = artifact.envelope.metadata.description;
  const { carries, fingerprint } = carriedIn(artifact.envelope, manifest);
  return {
    plugin: {
      name: sanitizeName(artifact.envelope.metadata.name),
      ...(description === undefined ? {} : { description: sanitizeText(description) }),
      ...(manifest === undefined ? {} : { manifest }),
      commands,
      carries,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    },
  };
}

/** Only a status worded as text, so a backend cannot print a control sequence through it. */
export function statusOf(artifact: Artifact): Pick<Placement, "status"> {
  const { name, reason } = artifact.status ?? {};
  if (typeof name !== "string" || name.trim() === "") return {};
  const why = typeof reason === "string" && reason.trim() !== "" ? sanitizeText(reason) : undefined;
  return { status: { name: sanitizeText(name), reason: why } };
}

export function because(yanked: { reason: string | undefined }): string {
  return yanked.reason === undefined ? "" : ` (${sanitizeText(yanked.reason)})`;
}

/** The lock row that installs this entry at this version already, which a yank does not undo. */
export function heldAs(
  lock: Lock,
  alias: string,
  path: string,
  version: string | undefined,
): string | undefined {
  return Object.entries(lock.artifacts).find(
    ([, row]) => row.registry === alias && row.address === path && row.version === version,
  )?.[0];
}

/** Yanked versions this run would install that the lock does not already hold. */
export function newlyYanked(acquired: readonly Acquired[], lock: Lock): string[] {
  return acquired.flatMap((source) =>
    [...source.placements].flatMap(([path, { name, version, yanked }]) =>
      yanked === undefined || holds(lock, source.alias, path, version)
        ? []
        : [`"${sanitizeText(name)}" ${version} is yanked${because(yanked)}`],
    ),
  );
}

function holds(lock: Lock, alias: string, path: string, version: string | undefined): boolean {
  return heldAs(lock, alias, path, version) !== undefined;
}
