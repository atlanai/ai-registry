import type { LockArtifact } from "#core/lock.ts";
import { type ProjectionScope, rowPlugin } from "#core/plan/projection.ts";
import { type ArtifactSurvey, copyEdited, editedHere } from "#core/plan/survey.ts";

/** A target's copy edited since aireg wrote it, other than a copied plugin folder. */
export function editedCopy(
  name: string,
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
  options: ProjectionScope,
): LockArtifact["links"][number] | undefined {
  // A plugin folder holds the whole namespace, so it is backed up when next copied, not kept.
  return entry?.links.find(
    (link) => copyEdited(link, state) && rowPlugin(name, entry, link, options) === undefined,
  );
}

/** Edited here or in a target's own copy, so not ours to replace unasked. */
export function editedKept(
  name: string,
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
  options: ProjectionScope,
): boolean {
  return editedHere(entry, state) || editedCopy(name, entry, state, options) !== undefined;
}
