import { posixRelative } from "#core/fs/path.ts";
import type { LinkMode, Lock, LockArtifact } from "#core/lock.ts";
import type { Rewritten, Selected } from "#core/plan/model.ts";
import type { PlannedLink } from "#core/plan/projection.ts";
import { type ArtifactSurvey, editedAnywhere } from "#core/plan/survey.ts";

interface RowInput {
  item: Selected;
  links: readonly PlannedLink[];
  previous: LockArtifact | undefined;
  state: ArtifactSurvey | undefined;
  /** This run stages the item's bytes again. */
  restage: boolean;
  /** Path to this scope's copy of the item. */
  copy: string;
  base: string;
  neededBy: string[] | undefined;
}

export function lockRow({
  item,
  links,
  previous,
  state,
  restage,
  copy,
  base,
  neededBy,
}: RowInput): LockArtifact {
  // An edited copy keeps its install basis so `outdated` still sees newer versions and a publish
  // never skips one; a row of yours keeps what it last sent until a pull or served publish.
  const yours = !restage && previous?.origin !== undefined;
  const basis = yours || (!restage && editedAnywhere(previous, state)) ? previous : undefined;
  // Never adopt a drifted digest; the survey fallback is a copy the lock forgot, so drift stays
  // detectable. Pull never claims a row as yours: only an origins step writes `origin`.
  return {
    registry: item.source,
    id: basis?.id ?? item.id,
    name: item.upstreamName,
    kind: item.kind,
    namespace: item.group,
    address: basis?.address ?? item.path,
    path: posixRelative(base, copy),
    content: yours ? previous.content : (basis?.content ?? item.contentId ?? previous?.content),
    version: basis === undefined ? item.version : basis.version,
    ...carriedOf(basis === undefined ? fingerprintOf(item, previous) : basis.carried),
    ...revisionOf(basis === undefined ? item.revision : basis.revision),
    digest: restage ? "" : (previous?.digest ?? state?.digest ?? ""),
    origin: previous?.origin,
    links: links.map((link) => {
      const mode = modeOf(link, previous);
      const written = previous?.links.find((old) => old.path === link.relative)?.digest;
      return {
        target: link.target,
        path: link.relative,
        mode,
        ...(mode === "copy" && written !== undefined ? { digest: written } : {}),
      };
    }),
    ...(neededBy === undefined ? {} : { neededBy }),
  };
}

function carriedOf(fingerprint: string | undefined): Pick<LockArtifact, "carried"> {
  return fingerprint === undefined ? {} : { carried: fingerprint };
}

/**
 * What the plugin runs, as read this run; a run that read nothing of it, as an install off the
 * lockfile, has the same bytes as before and so the same parts.
 */
function fingerprintOf(item: Selected, previous: LockArtifact | undefined): string | undefined {
  if (item.plugin !== undefined) return item.plugin.fingerprint;
  return item.contentId !== undefined && item.contentId === previous?.content
    ? previous.carried
    : undefined;
}

function revisionOf(revision: string | undefined): Pick<LockArtifact, "revision"> {
  return revision === undefined ? {} : { revision };
}

/** A link this run makes records what `apply` made; one it leaves alone keeps what it was. */
function modeOf(link: PlannedLink, previous: LockArtifact | undefined): LinkMode {
  return previous?.links.find((old) => old.path === link.relative)?.mode ?? "symlink";
}

/** A released version is immutable, so other bytes under it are never a change to take. */
export function rewrittenFrom(
  item: Selected,
  previous: LockArtifact | undefined,
): Rewritten | undefined {
  if (previous?.registry !== item.source || previous.address !== item.path) return undefined;
  if (item.version === undefined || previous.version !== item.version) return undefined;
  if (item.contentId === undefined || previous.content === undefined) return undefined;
  if (previous.content === item.contentId) return undefined;
  return {
    name: item.name,
    version: item.version,
    locked: previous.content,
    served: item.contentId,
  };
}

/**
 * The revision says what the lock was resolved at; serving the same rows again does not move it.
 * A registry at a new address is another source, with a revision of its own.
 */
export function keepUnmovedRevisions(before: Lock, next: Lock): void {
  for (const [alias, source] of Object.entries(next.registries)) {
    const held = before.registries[alias];
    if (held !== undefined && held.key === source.key && unmoved(before, next, alias)) {
      next.registries[alias] = { ...source, revision: held.revision };
    }
  }
}

/** Whether a registry's rows resolved to exactly what the lock already held. */
function unmoved(before: Lock, after: Lock, alias: string): boolean {
  const rows = (lock: Lock) =>
    Object.entries(lock.artifacts).filter(([, row]) => row.registry === alias);
  const held = rows(before);
  return (
    held.length === rows(after).length &&
    held.every(([name, row]) => {
      const now = after.artifacts[name];
      return (
        now !== undefined &&
        now.registry === alias &&
        now.id === row.id &&
        now.name === row.name &&
        now.kind === row.kind &&
        now.namespace === row.namespace &&
        now.address === row.address &&
        now.content === row.content &&
        now.version === row.version
      );
    })
  );
}
