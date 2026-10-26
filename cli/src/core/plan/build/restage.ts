import { quoted } from "#adapter/text.ts";
import { nativePath } from "#core/kinds.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import {
  type Acquired,
  type ArtifactSurvey,
  copyEdited,
  editedAnywhere,
  editedHere,
  type Selected,
} from "#core/plan/model.ts";
import { scopeName, stagingPath } from "#core/store/paths.ts";
import type { BuildState } from "./state.ts";

function movedUpstream(
  item: Selected,
  previous: LockArtifact | undefined,
  source: Acquired | undefined,
  lock: Lock,
  refresh: boolean,
): boolean {
  const revision = source?.origin.revision;
  if (
    previous === undefined ||
    previous.address !== item.path ||
    previous.id !== item.id ||
    previous.name !== item.upstreamName
  ) {
    return true;
  }
  const pinned = lock.registries[previous.registry]?.revision;
  // Adopted content records no basis and an unpinned source cannot reconstruct
  // one, so restage while the copy on disk still matches the lock.
  if (revision === undefined && pinned === undefined) {
    if (previous.content === undefined) return true;
    // A refresh asks the source again; identical bytes are not new, so `update`
    // reports no work on an up-to-date tree.
    if (refresh && item.contentId === undefined) return true;
  }

  return item.contentId !== undefined && previous.content !== undefined
    ? previous.content !== item.contentId
    : pinned !== revision;
}

/** Under `--force`, or for a row whose copy this run published: the source holds those bytes. */
function forced(item: Selected, build: BuildState): boolean {
  return build.options.force || build.options.restate?.has(item.name) === true;
}

function shouldRestage(
  item: Selected,
  previous: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
  build: BuildState,
): boolean {
  // A copy this scope holds that the lock never described the content of: a
  // person's work, or an interrupted run. Not ours to overwrite unasked.
  const unlocked = state?.staged === true && (previous === undefined || previous.digest === "");
  const edited = editedAnywhere(previous, state);
  const copied = editedHere(previous, state)
    ? undefined
    : previous?.links.find((link) => copyEdited(link, state));

  if (!edited && !unlocked) {
    const source = build.byAlias.get(item.source);
    return (
      movedUpstream(item, previous, source, build.lock, build.options.refresh === true) ||
      state?.staged !== true
    );
  }
  if (!forced(item, build)) {
    build.warnings.push(
      unlocked
        ? {
            name: item.name,
            message: `${quoted(item.name)} was already in ${scopeName(build.options.roots.scope)} and the lockfile did not record it, so it was kept as it is.`,
            hint: "Run `aireg sync` to compare it with its registry, or `aireg install --force` to replace it with the registry copy.",
          }
        : copied !== undefined
          ? {
              name: item.name,
              message: `${quoted(item.name)} was edited after installation in ${copied.path}, so it was left as it is.`,
              hint: "Run `aireg install --force` to replace it.",
            }
          : {
              name: item.name,
              message: `${quoted(item.name)} was edited after installation, so it was left as it is.`,
              hint: "Run `aireg sync` to compare it with its registry, or `aireg install --force` to restore the version in the lockfile.",
            },
    );
  }
  return forced(item, build);
}

/**
 * Whether this run stages the item's bytes again. A missing copy is made again from what the
 * lock holds; when the source no longer serves that, the copy and the row both move to what it serves.
 */
export function restages(
  item: Selected,
  previous: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
  build: BuildState,
): boolean {
  const missing = state?.staged !== true;
  // A row of yours is its folder's copy: only `sync resolve --theirs` puts the registry's over it.
  if (previous?.origin !== undefined && !missing && !build.options.force) return false;
  return (
    shouldRestage(item, previous, state, build) || (missing && item.contentId !== previous?.content)
  );
}

/**
 * Staged bytes are upstream's; the copy is this scope's, and everything a target sees is
 * projected from it, so an edit never reaches what upstream published.
 */
export function planCopy(item: Selected, copy: string, build: BuildState): void {
  const staged = stagingPath(item.contentId);
  build.actions.push({
    kind: "stage",
    name: item.name,
    source: item.source,
    path: item.path,
    to: staged,
  });
  build.actions.push({
    kind: "clone",
    name: item.name,
    from: nativePath(staged, item.kind, item.path),
    to: copy,
  });
}
