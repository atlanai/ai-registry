import { posixRelative } from "#core/fs/path.ts";
import type { LinkMode, Lock, LockArtifact } from "#core/lock.ts";
import {
  type ArtifactSurvey,
  editedAnywhere,
  type Rewritten,
  type Selected,
} from "#core/plan/model.ts";
import type { PlannedLink } from "#core/plan/projection.ts";

interface RowInput {
  item: Selected;
  links: readonly PlannedLink[];
  previous: LockArtifact | undefined;
  state: ArtifactSurvey | undefined;
  /** This run stages the item's bytes again. */
  restage: boolean;
  /** This scope's copy of the item. */
  copy: string;
  base: string;
  neededBy: string[] | undefined;
}

/** The lock row a planned artifact records. */
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
  // An edited copy left in place stays based on what it was installed from, so
  // `outdated` still sees the newer version and a publish never skips over it.
  // A row of yours stays based on what it last sent, until a pull or a served publish moves it.
  const yours = !restage && previous?.origin !== undefined;
  const basis = yours || (!restage && editedAnywhere(previous, state)) ? previous : undefined;
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
    // Never adopt a drifted digest: the lock records what we installed. The
    // survey fallback is a copy the lock forgot, so drift stays detectable.
    digest: restage ? "" : (previous?.digest ?? state?.digest ?? ""),
    // Pull never claims a row as yours; only an origins step writes this.
    origin: previous?.origin,
    links: links.map((link) => {
      const mode = modeOf(link, previous);
      const written = previous?.links.find((old) => old.path === link.relative)?.digest;
      return {
        harness: link.harness,
        path: link.relative,
        mode,
        ...(mode === "copy" && written !== undefined ? { digest: written } : {}),
      };
    }),
    ...(neededBy === undefined ? {} : { neededBy }),
  };
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

/** The revision says what the lock was resolved at; serving the same rows again does not move it. */
export function keepUnmovedRevisions(before: Lock, next: Lock): void {
  for (const [alias, source] of Object.entries(next.registries)) {
    const held = before.registries[alias];
    if (held !== undefined && unmoved(before, next, alias)) {
      next.registries[alias] = { ...source, revision: held.revision };
    }
  }
}
