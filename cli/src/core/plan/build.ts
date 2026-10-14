import { dict } from "#core/fields.ts";
import { emptyLock, type Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import {
  carryUnopened,
  carryUnresolved,
  heldElsewhere,
  keep,
  namespaceWants,
} from "#core/plan/build/carry.ts";
import { placeLinks, updateLinks } from "#core/plan/build/links.ts";
import { keepUnmovedRevisions, lockRow, rewrittenFrom } from "#core/plan/build/lock-row.ts";
import { planCopy, restages } from "#core/plan/build/restage.ts";
import type { BuildOptions, BuildState } from "#core/plan/build/state.ts";
import { flushUnlinks, removeStale } from "#core/plan/build/unlink.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import { closure, dependentsByName, nameClashes } from "./depends.ts";
import type { Acquired, Clash, Incompatible, Plan, Selected, Survey, Warning } from "./model.ts";
import { dropUnusedSources, lockSourceOf } from "./model.ts";
import { crowdedContainers } from "./projection.ts";
import { addressOf, select } from "./select.ts";

export type { BuildOptions } from "#core/plan/build/state.ts";

/** Pure planning keeps dry runs and applied runs on the same decision path. */
export function build(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
  survey: Survey,
  options: BuildOptions,
): Plan {
  const warnings: Warning[] = acquired.flatMap((source) =>
    source.catalog.warnings.map((message) => ({ name: source.alias, message })),
  );
  const incompatible: Incompatible[] = [];
  const clashes: Clash[] = [];
  const top = select(manifest, lock, acquired, [], options.cliVersion, []);
  const needs = closure(top, acquired);
  const selected = select(
    { ...manifest, artifacts: [...manifest.artifacts, ...needs.refs] },
    lock,
    acquired,
    warnings,
    options.cliVersion,
    incompatible,
    clashes,
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
    linked: new Set(),
    wrapping: new Set(
      acquired.filter((source) => source.namespacePlugins).map((source) => source.alias),
    ),
    crowded: new Set(),
    unlinks: [],
    neededBy: dependentsByName(needs, selected, lock),
    pruned: [],
    addresses: new Map(),
    clashes,
  };

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
  carryUnresolved(state, needs);
  removeStale(state);
  flushUnlinks(state, held);
  dropUnusedSources(next);
  keepUnmovedRevisions(lock, next);

  for (const clash of clashes) {
    warnings.push({
      name: clash.name,
      message: `${clashMessage(clash)}; keeping ${clash.kept}.`,
      hint: "Give one another name with `as:` in the manifest.",
    });
  }
  state.actions.push({ kind: "record", lock: next });
  const direct = new Set(top.map((item) => item.name));
  return {
    actions: state.actions,
    unchanged: state.unchanged,
    warnings,
    incompatible,
    rewritten: state.rewritten,
    clashes,
    neededBy: dict(
      [...state.neededBy].filter(
        ([name]) => !direct.has(name) && next.artifacts[name] !== undefined,
      ),
    ),
    pruned: state.pruned.sort(),
    unresolved: needs.unresolved,
    conflicts: [...needs.conflicts, ...nameClashes(needs, selected)],
  };
}

function planItem(item: Selected, build: BuildState): void {
  const previous = build.lock.artifacts[item.name];
  const rewritten = rewrittenFrom(item, previous);
  if (rewritten !== undefined && previous !== undefined) {
    build.rewritten.push(rewritten);
    keep(build, item.name, previous);
    return;
  }
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
