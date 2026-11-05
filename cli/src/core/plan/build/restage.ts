import { quoted } from "#adapter/text.ts";
import { nativePath } from "#core/kinds.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Acquired, Selected } from "#core/plan/model.ts";
import { type ArtifactSurvey, copyEdited, editedAnywhere, editedHere } from "#core/plan/survey.ts";
import { scopeName, stagingPath } from "#core/store/paths.ts";
import type { BuildState } from "./state.ts";

/** A missing copy is restaged from the lock; if the source no longer serves that, both move. */
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

function shouldRestage(
  item: Selected,
  previous: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
  build: BuildState,
): boolean {
  // A copy the lock never described is a person's work or an interrupted run: keep it unless asked.
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
  if (!forced(item, build)) build.warnings.push(keptWarning(item, build, unlocked, copied?.path));
  return forced(item, build);
}

function keptWarning(
  item: Selected,
  build: BuildState,
  unlocked: boolean,
  copiedPath: string | undefined,
): BuildState["warnings"][number] {
  if (unlocked) {
    return {
      name: item.name,
      message: `${quoted(item.name)} was already in ${scopeName(build.options.roots.scope)} and the lockfile did not record it, so it was kept as it is.`,
      hint: "Run `aireg sync` to compare it with its registry, or `aireg install --force` to replace it with the registry copy.",
    };
  }
  if (copiedPath !== undefined) {
    return {
      name: item.name,
      message: `${quoted(item.name)} was edited after installation in ${copiedPath}, so it was left as it is.`,
      hint: "Run `aireg install --force` to replace it.",
    };
  }
  return {
    name: item.name,
    message: `${quoted(item.name)} was edited after installation, so it was left as it is.`,
    hint: "Run `aireg sync` to compare it with its registry, or `aireg install --force` to restore the version in the lockfile.",
  };
}

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
  // Adopted content has no basis and an unpinned source cannot rebuild one, so restage.
  if (revision === undefined && pinned === undefined) {
    if (previous.content === undefined) return true;
    // Identical bytes are not new, so `update` reports no work on an up-to-date tree.
    if (refresh && item.contentId === undefined) return true;
  }

  return item.contentId !== undefined && previous.content !== undefined
    ? previous.content !== item.contentId
    : pinned !== revision;
}

/** A row whose copy this run published counts as forced: the source holds those bytes. */
function forced(item: Selected, build: BuildState): boolean {
  return build.options.force || build.options.restate?.has(item.name) === true;
}

/** Targets see the scope's copy, never the staged upstream bytes, so edits stay local. */
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
