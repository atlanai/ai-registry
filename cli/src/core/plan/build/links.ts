import { resolve } from "node:path";
import { list, quoted } from "#adapter/text.ts";
import { isStoreOnly } from "#core/kinds.ts";
import type { LinkMode, LockArtifact } from "#core/lock.ts";
import type { Action, Selected } from "#core/plan/model.ts";
import { claim, linksFor, type PlannedLink } from "#core/plan/projection.ts";
import { removal } from "#core/plan/removable.ts";
import { addressOf } from "#core/plan/select.ts";
import { type ArtifactSurvey, copyEdited } from "#core/plan/survey.ts";
import { scopeName } from "#core/store/paths.ts";
import { renamedTo } from "./rename.ts";
import type { BuildState } from "./state.ts";
import { unlinkRecorded } from "./unlink.ts";

type Blocked = NonNullable<LockArtifact["blocked"]>[number];

interface Claimed {
  links: PlannedLink[];
  /** Targets, by display name, that cannot load this kind. */
  skipped: Set<string>;
  /** Targets, by display name, that load this kind only in the other scope. */
  elsewhere: Set<string>;
  /** Paths another artifact already holds. */
  blocked: Blocked[];
}

const partName = (path: string) => (path.split(/[\\/]/).at(-1) ?? path).replace(/\.(md|toml)$/, "");

/** Before any other artifact claims a path. */
export function wantedLinks(item: Selected, build: BuildState): PlannedLink[] {
  const wrapped = build.wrapping.has(item.source);
  return linksFor(item, "", build.options, wrapped, build.crowded);
}

/**
 * In a project a link is written only where it could also be removed: a committed symlink on
 * the way would carry the write outside it.
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
    // The folder of yours this row came from is already there, and its target loads it.
    if (link.relative === previous?.origin?.path) {
      yours = true;
      return false;
    }
    if (!project) return true;
    const verdict = removal(link.absolute, build.options.roots, build.options.env);
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
  // A kind no coding agent has a folder for is installed once the scope holds its copy.
  if (
    links.length === 0 &&
    claimed.blocked.length === 0 &&
    !refused &&
    !yours &&
    !configured(item, build) &&
    !isStoreOnly(item.kind)
  ) {
    const other = build.options.roots.scope === "project" ? "user" : "project";
    const reasons = [
      ...(claimed.skipped.size === 0
        ? []
        : [`${list([...claimed.skipped])} cannot load ${item.kind}s`]),
      ...(claimed.elsewhere.size === 0
        ? []
        : [
            `${list([...claimed.elsewhere])} ${claimed.elsewhere.size === 1 ? "loads" : "load"} ${item.kind}s only in ${scopeName(other)}`,
          ]),
    ];
    const why =
      reasons.length === 0 ? `no selected target accepts a ${item.kind}` : reasons.join("; ");
    build.warnings.push({
      name: item.name,
      message: `${quoted(item.name)} was fetched but installed into no target: ${why}.`,
    });
  }
  return { links, blocked: claimed.blocked };
}

/** First come, first served; records what another artifact holds. */
function claimLinks(item: Selected, copy: string, build: BuildState): Claimed {
  const skipped = new Set<string>();
  const elsewhere = new Set<string>();
  const blocked: Blocked[] = [];
  const address = addressOf({ ...item, name: item.upstreamName }, item.source);
  build.addresses.set(item.name, address);
  const wrapped = build.wrapping.has(item.source);
  const planned = linksFor(item, copy, build.options, wrapped, build.crowded, (target, kind) => {
    const tool = build.options.targetTable[target];
    (tool?.kinds[kind]?.scope === undefined ? skipped : elsewhere).add(tool?.displayName ?? target);
  });
  const collided = (owner: string, link: PlannedLink) => {
    const kept = build.addresses.get(owner) ?? owner;
    blocked.push({ target: link.target, path: link.relative, by: kept });
    if (!build.clashes.some((clash) => clash.dropped === address && clash.kept === kept)) {
      // A plugin's parts each land under a name of their own, which is the one that collided.
      const name = item.kind === "plugin" ? partName(link.relative) : item.name;
      const container = link.shared === true ? { container: true as const } : {};
      build.clashes.push({ name, kept, dropped: address, at: link.relative, ...container });
    }
  };
  // A path the lockfile gives another artifact stays its own, though this one comes first, as a
  // plugin linked beside it may.
  const open = planned.filter((link) => {
    if (build.claimed.has(link.absolute)) return true;
    const holder = build.recorded.get(link.absolute);
    if (holder === undefined || holder === item.name || !holds(holder, link, build)) return true;
    collided(holder, link);
    return false;
  });
  const links = claim(open, item.name, build.claimed, build.plugins, collided);
  return { links, skipped, elsewhere, blocked };
}

/**
 * Whether the lockfile row recorded at this path still keeps it from `link`: only while that row
 * links there this run, and a plugin directory never from its own namespace's artifacts.
 */
function holds(holder: string, link: PlannedLink, build: BuildState): boolean {
  const wants = build.wants.get(holder);
  if (wants === undefined) return true;
  const wanted = wants.find((each) => each.absolute === link.absolute);
  if (wanted === undefined) return false;
  return link.shared !== true || wanted.content !== link.content;
}

interface LinkUpdate {
  item: Selected;
  links: readonly PlannedLink[];
  previous: LockArtifact | undefined;
  state: ArtifactSurvey | undefined;
  restage: boolean;
}

/** Plans missing links and takes back ones the item left; true if it planned any. */
export function updateLinks(
  { item, links, previous, state, restage }: LinkUpdate,
  build: BuildState,
): boolean {
  let touched = restage;
  for (const link of links) {
    const rename = link.shared === true ? undefined : renamedTo(item);
    const own = previous?.links.find((old) => old.path === link.relative);
    // A plugin folder belongs to its whole namespace, so a new member finds it recorded too.
    const prior = link.shared === true && !placed(own, previous) ? sharedAt(build, link) : own;
    const requested =
      link.codec !== undefined ||
      link.entry !== undefined ||
      link.copy === true ||
      rename !== undefined ||
      build.options.copy ||
      item.copy === true;
    // A copy no run asked for, one taken over or made where a link would not do, stays while it
    // is here: a committed lock never makes another machine copy.
    const kept =
      prior?.mode === "copy" &&
      prior.requested !== true &&
      link.shared !== true &&
      isCopy(state?.links[link.relative]);
    const copying = requested || kept;
    // A placement kept back last run is tried again, so it is reported until it lands.
    const correct =
      inPlace(state?.links[link.relative], copying, link.from) &&
      !keptBack(previous, link.relative);
    // An edited plugin copy is backed up when it is next copied, not kept: its members move on.
    if (link.shared !== true && keepsEditedCopy(prior, state, build)) continue;
    if ((restage || !correct) && !build.linked.has(link.absolute)) {
      build.linked.add(link.absolute);
      const adopt = build.options.adopt?.has(item.name) === true;
      build.actions.push(
        linkAction(item, link, {
          copy: copying,
          requested,
          rename,
          recorded: prior?.mode,
          written: link.shared === true ? prior?.digest : undefined,
          adopt,
        }),
      );
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

type RecordedLink = LockArtifact["links"][number];

/** Planned last run but kept back, as when something of a person's stood there. */
function keptBack(row: LockArtifact | undefined, path: string): boolean {
  return row?.blocked?.some((each) => each.path === path) === true;
}

function placed(own: RecordedLink | undefined, row: LockArtifact | undefined): boolean {
  return own !== undefined && !keptBack(row, own.path);
}

/** The plugin folder as a member that placed it recorded it, with the bytes it holds. */
function sharedAt(build: BuildState, link: PlannedLink): RecordedLink | undefined {
  if (link.shared !== true) return undefined;
  for (const row of Object.values(build.lock.artifacts)) {
    const recorded = row.links.find((each) => each.path === link.relative);
    if (placed(recorded, row)) return recorded;
  }
  return undefined;
}

/**
 * A copied plugin holds its members' bytes, so one that lost a member is copied again for a
 * member still in it.
 */
export function recopyPlugins(build: BuildState): void {
  for (const { to, link } of build.unlinks) {
    if (link?.mode === "copy") recopyPlugin(build, to);
  }
}

function recopyPlugin(build: BuildState, to: string): void {
  const holder = build.claimed.get(to);
  if (holder === undefined || build.linked.has(to)) return;
  const link = build.wants
    .get(holder)
    ?.find((each) => each.absolute === to && each.shared === true && each.copy === true);
  if (link === undefined) return;
  const prior = sharedAt(build, link);
  build.linked.add(to);
  build.actions.push(
    linkAction({ name: holder }, link, {
      copy: true,
      rename: undefined,
      recorded: prior?.mode,
      written: prior?.digest,
      adopt: false,
    }),
  );
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

function isCopy(observed: ArtifactSurvey["links"][string] | undefined): boolean {
  return observed?.present === true && !observed.isLink;
}

/** A target's own copy that was edited stays as it is unless forced; planning has said so. */
function keepsEditedCopy(
  prior: LockArtifact["links"][number] | undefined,
  state: ArtifactSurvey | undefined,
  build: BuildState,
): boolean {
  return prior !== undefined && !build.options.force && copyEdited(prior, state);
}

function linkAction(
  item: Pick<Selected, "name">,
  link: PlannedLink,
  how: {
    copy: boolean;
    requested?: boolean;
    rename: string | undefined;
    recorded: LinkMode | undefined;
    written?: string | undefined;
    adopt: boolean;
  },
): Extract<Action, { kind: "link" }> {
  return {
    kind: "link",
    name: item.name,
    target: link.target,
    from: link.from,
    to: link.absolute,
    copy: how.copy,
    ...(how.requested === true ? { requested: true } : {}),
    plugin: link.shared === true,
    ...(link.content === undefined ? {} : { content: link.content }),
    ...(link.document === undefined ? {} : { document: link.document }),
    ...(link.fan === true ? { fan: true } : {}),
    ...(link.codec === undefined ? {} : { codec: link.codec }),
    ...(link.command === undefined ? {} : { command: link.command }),
    ...(link.keys === undefined ? {} : { keys: link.keys }),
    ...(link.part === undefined ? {} : { part: link.part }),
    ...(link.entry === undefined ? {} : { entry: link.entry }),
    ...(link.depth === undefined ? {} : { depth: link.depth }),
    ...(how.rename === undefined ? {} : { rename: how.rename }),
    ...(how.recorded === undefined ? {} : { recorded: how.recorded }),
    ...(how.written === undefined ? {} : { written: how.written }),
    ...(how.adopt && link.codec === undefined && link.entry === undefined && link.shared !== true
      ? { adopt: true }
      : {}),
  };
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
    message: `The namespace ${quoted(link.renamed.namespace)} is also published by another registry, so ${link.target} loads the one from ${item.source} as ${quoted(link.renamed.name)}.`,
  });
}

/** A kind a selected target writes into its config is installed there, not placed. */
function configured(item: Selected, build: BuildState): boolean {
  return build.options.targets.some(
    (name) => build.options.targetTable[name]?.kinds[item.kind]?.shape === "config",
  );
}
