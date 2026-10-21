import { resolve } from "node:path";
import { list, plural, sanitizeText } from "#adapter/text.ts";
import { statusWarning } from "#core/catalog/withheld.ts";
import { dict } from "#core/fields.ts";
import { emptyLock, type Lock, type LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import {
  carryUnlisted,
  carryUnopened,
  carryUnresolved,
  carryUntrusted,
  carryWithheld,
  heldElsewhere,
  keep,
  namespaceWants,
} from "#core/plan/build/carry.ts";
import { placeLinks, updateLinks } from "#core/plan/build/links.ts";
import { keepUnmovedRevisions, lockRow, rewrittenFrom } from "#core/plan/build/lock-row.ts";
import { carriedOut, renamesFor } from "#core/plan/build/rename.ts";
import { planCopy, restages } from "#core/plan/build/restage.ts";
import type { BuildOptions, BuildState } from "#core/plan/build/state.ts";
import { flushUnlinks, removeStale } from "#core/plan/build/unlink.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import { closure, dependentsByName, nameClashes } from "./depends.ts";
import type { Acquired, Clash, Incompatible, Plan, Selected, Survey, Warning } from "./model.ts";
import { dropUnusedSources, lockSourceOf } from "./model.ts";
import { crowdedContainers } from "./projection.ts";
import { addressOf, select, type Untrusted } from "./select.ts";

export type { BuildOptions } from "#core/plan/build/state.ts";

/**
 * Pure planning keeps dry runs and applied runs on the same decision path. A clash this
 * run may settle by renaming is planned again, under the names the first plan picked.
 */
export function build(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
  survey: Survey,
  options: BuildOptions,
): Plan {
  const planned = planWith({ manifest, lock, acquired, survey, options }, new Map());
  if (options.nameCollision !== "rename") return planned.plan;
  const renames = renamesFor(planned.plan.clashes, planned.selected, Object.keys(lock.artifacts));
  if (renames.size === 0) return planned.plan;
  const { plan } = planWith({ manifest, lock, acquired, survey, options }, renames);
  return { ...plan, renamed: carriedOut(renames, planned.plan.clashes, plan.clashes) };
}

interface Inputs {
  manifest: Manifest;
  lock: Lock;
  acquired: readonly Acquired[];
  survey: Survey;
  options: BuildOptions;
}

function planWith(
  { manifest, lock, acquired, survey, options }: Inputs,
  renames: ReadonlyMap<string, string>,
): { plan: Plan; selected: Selected[] } {
  const warnings: Warning[] = acquired.flatMap((source) =>
    source.catalog.warnings.map((message) => ({ name: source.alias, message })),
  );
  const incompatible: Incompatible[] = [];
  const clashes: Clash[] = [];
  const top = select(manifest, lock, acquired, [], options.cliVersion, [], [], renames);
  const needs = closure(top, acquired);
  const untrusted: Untrusted[] = [];
  const selected = select(
    { ...manifest, artifacts: [...manifest.artifacts, ...needs.refs] },
    lock,
    acquired,
    warnings,
    options.cliVersion,
    incompatible,
    clashes,
    renames,
    untrusted,
  );
  const next = emptyLock();
  for (const source of acquired) {
    next.registries[source.alias] = lockSourceOf(source.origin);
  }
  const state: BuildState = {
    lock,
    survey,
    options,
    byAlias: new Map(acquired.map((entry) => [entry.alias, entry])),
    actions: [],
    unchanged: [],
    next,
    warnings,
    rewritten: [],
    claimed: new Map(),
    recorded: new Map(),
    linked: new Set(),
    // Namespaces wrap only at user scope, as the adapter contract says, whoever loads plugins.
    wrapping: new Set(
      options.roots.scope === "user"
        ? acquired.filter((source) => source.namespacePlugins).map((source) => source.alias)
        : [],
    ),
    crowded: new Set(),
    unlinks: [],
    neededBy: dependentsByName(needs, selected, lock),
    pruned: [],
    addresses: new Map(),
    clashes,
  };

  for (const item of selected) {
    // Known before any item claims a path, so a collision names its holder however late it comes.
    state.addresses.set(item.name, addressOf({ ...item, name: item.upstreamName }, item.source));
    for (const link of lock.artifacts[item.name]?.links ?? []) {
      state.recorded.set(resolve(options.roots.base, link.path), item.name);
    }
  }
  const carried = carryUnopened(state);
  const held = heldElsewhere(state, manifest, acquired, carried);
  state.crowded = crowdedContainers(namespaceWants(selected, carried, held, state), options);
  // Links go first come, first served, and what is installed already comes first: adding
  // another artifact under its name never unlinks it.
  const linkedFirst = [...selected].sort(
    (a, b) => Number(isLinked(lock, b)) - Number(isLinked(lock, a)),
  );
  for (const item of linkedFirst) {
    const holder = carried.has(item.name) ? lock.artifacts[item.name] : undefined;
    // A full run would weigh both; one that did not open the holder keeps it.
    if (holder !== undefined) clashes.push(heldClash(item, holder));
    else planItem(item, state);
  }
  const withheld = carryWithheld(state, acquired);
  const unlisted = carryUnlisted(state, manifest, acquired);
  carryUntrusted(state, untrusted);
  carryUnresolved(state, needs);
  removeStale(state);
  flushUnlinks(state, held);
  dropUnusedSources(next);
  keepUnmovedRevisions(lock, next);

  state.actions.push({ kind: "record", lock: next });
  const direct = new Set(top.map((item) => item.name));
  const plan: Plan = {
    actions: state.actions,
    unchanged: state.unchanged,
    warnings,
    incompatible,
    rewritten: state.rewritten,
    clashes,
    renamed: [],
    neededBy: dict(
      [...state.neededBy].filter(
        ([name]) => !direct.has(name) && next.artifacts[name] !== undefined,
      ),
    ),
    pruned: state.pruned.sort(),
    unresolved: needs.unresolved,
    conflicts: [...needs.conflicts, ...nameClashes(needs, selected)],
    withheld,
    unlisted,
    untrusted,
  };
  return { plan, selected };
}

function planItem(item: Selected, build: BuildState): void {
  const previous = build.lock.artifacts[item.name];
  const rewritten = rewrittenFrom(item, previous);
  if (rewritten !== undefined && previous !== undefined) {
    build.rewritten.push(rewritten);
    keep(build, item.name, previous);
    return;
  }
  warnStatus(item, previous, build);
  warnLeftOut(item, previous, build);
  const state = build.survey.artifacts[item.name];
  const copy = artifactPath(
    build.options.roots,
    item.source,
    item.group,
    item.kind,
    copyLeaf(item.name, item.upstreamName),
    item.path,
  );
  const restage = restages(item, previous, state, build);
  // A copy is only ever made from bytes this run checked, so making one stages too.
  if (restage || state?.staged !== true) planCopy(item, copy, build);

  const { links, blocked } = placeLinks(item, copy, previous, build);
  if (!updateLinks({ item, links, previous, state, restage }, build)) {
    build.unchanged.push(item.name);
  }
  build.next.artifacts[item.name] = {
    ...lockRow({
      item,
      links,
      previous,
      state,
      restage,
      copy,
      base: build.options.roots.base,
      neededBy: build.neededBy.get(item.name),
    }),
    ...(blocked.length === 0 ? {} : { blocked }),
  };
}

/** A version installing with a status, such as deprecated, says so when this run moves to it. */
function warnStatus(item: Selected, previous: LockArtifact | undefined, build: BuildState): void {
  const status = build.byAlias.get(item.source)?.placements.get(item.path)?.status;
  if (status === undefined || item.version === undefined) return;
  if (previous !== undefined && previous.version === item.version) return;
  const { upstreamName: name, group, kind, version } = item;
  build.warnings.push({
    name: item.name,
    message: statusWarning({
      name,
      group,
      kind,
      version,
      status: status.name,
      reason: status.reason,
    }),
  });
}

function isLinked(lock: Lock, item: Selected): boolean {
  return (lock.artifacts[item.name]?.links.length ?? 0) > 0;
}

/** What a row of a registry this run did not open keeps from one it did. */
function heldClash(item: Selected, holder: Lock["artifacts"][string]): Clash {
  const { registry, namespace, kind, name } = holder;
  return {
    name: item.name,
    kept: addressOf({ group: namespace, kind, name }, registry),
    dropped: addressOf({ ...item, name: item.upstreamName }, item.source),
  };
}

/** Two artifacts that would take one installed name, or one path in a harness folder. */
export function clashMessage({ name, kept, dropped, at }: Clash): string {
  return at === undefined
    ? `${dropped} and ${kept} would both install as "${name}"`
    : `${dropped} and ${kept} would both install at ${at}`;
}

const NAMED_FILES = 5;

function warnLeftOut(item: Selected, previous: LockArtifact | undefined, build: BuildState): void {
  const leftOut = build.byAlias.get(item.source)?.placements.get(item.path)?.leftOut;
  if (leftOut === undefined || leftOut.files.length === 0) return;
  if (previous !== undefined && previous.version === item.version) return;
  const shown = [item.group, item.upstreamName].filter(Boolean).join("/");
  const at = item.version === undefined ? "" : ` ${item.version}`;
  const named = leftOut.files.slice(0, NAMED_FILES).map((file) => sanitizeText(file));
  const rest = leftOut.files.length - named.length;
  const files = rest === 0 ? list(named) : `${named.join(", ")} and ${plural(rest, "more file")}`;
  build.warnings.push({
    name: item.name,
    message: `${shown}${at} installs as its ${sanitizeText(leftOut.entry)} alone, since a harness takes ${item.kind === "agent" ? "an" : "a"} ${item.kind} as one file, so ${files} ${leftOut.files.length === 1 ? "is" : "are"} left out.`,
  });
}
