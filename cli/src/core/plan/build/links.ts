import { resolve } from "node:path";
import { list, quoted } from "#adapter/text.ts";
import type { LinkMode, LockArtifact } from "#core/lock.ts";
import { type Action, type ArtifactSurvey, copyEdited, type Selected } from "#core/plan/model.ts";
import { claim, linksFor, type PlannedLink } from "#core/plan/projection.ts";
import { removal } from "#core/plan/removable.ts";
import { addressOf } from "#core/plan/select.ts";
import { renamedTo } from "./rename.ts";
import type { BuildState } from "./state.ts";
import { unlinkRecorded } from "./unlink.ts";

type Blocked = NonNullable<LockArtifact["blocked"]>[number];

interface Claimed {
  links: PlannedLink[];
  /** Harnesses, by display name, that cannot load this kind. */
  skipped: Set<string>;
  /** Paths another artifact already holds. */
  blocked: Blocked[];
}

/** The links this item may take, first come first served, recording what another holds. */
function claimLinks(item: Selected, copy: string, build: BuildState): Claimed {
  const skipped = new Set<string>();
  const blocked: Blocked[] = [];
  const address = addressOf({ ...item, name: item.upstreamName }, item.source);
  build.addresses.set(item.name, address);
  const wrapped = build.wrapping.has(item.source);
  const planned = linksFor(item, copy, build.options, wrapped, build.crowded, (harness) => {
    skipped.add(build.options.harnesses[harness]?.displayName ?? harness);
  });
  const links = claim(planned, item.name, build.claimed, (owner, link) => {
    const kept = build.addresses.get(owner) ?? owner;
    blocked.push({ harness: link.harness, path: link.relative, by: kept });
    if (!build.clashes.some((clash) => clash.dropped === address && clash.kept === kept)) {
      build.clashes.push({ name: item.name, kept, dropped: address, at: link.relative });
    }
  });
  return { links, skipped, blocked };
}

/**
 * The links this item gets, and what blocks the rest. In a project a link is written only where
 * it could also be removed: a committed symlink on the way would carry the write outside it.
 */
export function placeLinks(
  item: Selected,
  copy: string,
  previous: LockArtifact | undefined,
  build: BuildState,
): { links: PlannedLink[]; blocked: Blocked[] } {
  const claimed = claimLinks(item, copy, build);
  const project = build.options.roots.scope === "project";
  let refused = false;
  let yours = false;
  const links = claimed.links.filter((link) => {
    // The folder of yours this row came from is already there, and its harness loads it.
    if (link.relative === previous?.origin?.path) {
      yours = true;
      return false;
    }
    if (!project) return true;
    const verdict = removal(link.absolute, build.options.roots);
    if (verdict.how !== "refuse") return true;
    refused = true;
    build.warnings.push({
      name: item.name,
      message: `Did not install ${item.name} at ${link.relative}: ${verdict.reason}.`,
    });
    return false;
  });
  // Said only when it lands nowhere: a tool skipping a kind another tool reads is
  // expected, and a clash or a refusal has already said where it went instead.
  if (links.length === 0 && claimed.blocked.length === 0 && !refused && !yours) {
    const why =
      claimed.skipped.size === 0
        ? `no selected harness accepts a ${item.kind}`
        : `${list([...claimed.skipped])} cannot load ${item.kind}s`;
    build.warnings.push({
      name: item.name,
      message: `${quoted(item.name)} was fetched but installed into no harness: ${why}.`,
    });
  }
  return { links, blocked: claimed.blocked };
}

interface LinkUpdate {
  item: Selected;
  links: readonly PlannedLink[];
  previous: LockArtifact | undefined;
  state: ArtifactSurvey | undefined;
  restage: boolean;
}

/** Plans the links that are not already in place and takes back the ones the item left; true if any. */
export function updateLinks(
  { item, links, previous, state, restage }: LinkUpdate,
  build: BuildState,
): boolean {
  let touched = restage;
  for (const link of links) {
    const rename = link.shared === true ? undefined : renamedTo(item);
    const copying =
      link.codec !== undefined ||
      link.entry !== undefined ||
      link.copy === true ||
      rename !== undefined ||
      build.options.copy ||
      item.copy === true;
    const correct = inPlace(state?.links[link.relative], copying, link.from);
    const prior = previous?.links.find((old) => old.path === link.relative);
    if (keepsEditedCopy(prior, state, build)) continue;
    if ((restage || !correct) && !build.linked.has(link.absolute)) {
      build.linked.add(link.absolute);
      build.actions.push(linkAction(item, link, { copy: copying, rename, recorded: prior?.mode }));
      touched = true;
      noteRenamed(item, link, prior?.mode, build);
    }
  }
  for (const stale of previous?.links ?? []) {
    if (links.some((link) => link.relative === stale.path)) continue;
    touched = unlinkRecorded(build, item.name, stale) || touched;
  }
  return touched;
}

function linkAction(
  item: Selected,
  link: PlannedLink,
  how: { copy: boolean; rename: string | undefined; recorded: LinkMode | undefined },
): Extract<Action, { kind: "link" }> {
  return {
    kind: "link",
    name: item.name,
    harness: link.harness,
    from: link.from,
    to: link.absolute,
    copy: how.copy,
    plugin: link.shared === true,
    ...(link.content === undefined ? {} : { content: link.content }),
    ...(link.fan === true ? { fan: true } : {}),
    ...(link.codec === undefined ? {} : { codec: link.codec }),
    ...(link.entry === undefined ? {} : { entry: link.entry }),
    ...(how.rename === undefined ? {} : { rename: how.rename }),
    ...(how.recorded === undefined ? {} : { recorded: how.recorded }),
  };
}

/** A copy is a real folder; anywhere else one means the link was replaced by content we do not own. */
function inPlace(
  observed: ArtifactSurvey["links"][string] | undefined,
  copying: boolean,
  from: string,
): boolean {
  return (
    observed?.present === true &&
    (copying ? !observed.isLink : observed.isLink) &&
    (observed.target === undefined || resolve(observed.target) === resolve(from))
  );
}

/** A harness's own copy that was edited stays as it is unless forced; planning has said so. */
function keepsEditedCopy(
  prior: LockArtifact["links"][number] | undefined,
  state: ArtifactSurvey | undefined,
  build: BuildState,
): boolean {
  return prior !== undefined && !build.options.force && copyEdited(prior, state);
}

/** Said once, when the renamed plugin first appears, rather than on every sync. */
function noteRenamed(
  item: Selected,
  link: PlannedLink,
  recorded: LinkMode | undefined,
  build: BuildState,
): void {
  if (link.renamed === undefined || recorded !== undefined) return;
  build.warnings.push({
    name: item.name,
    message: `The namespace ${quoted(link.renamed.namespace)} is also published by another registry, so ${link.harness} loads the one from ${item.source} as ${quoted(link.renamed.name)}.`,
  });
}
