import { posix } from "node:path";
import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import { list, plural, quoted, sanitizeName } from "#adapter/text.ts";
import {
  type Entry,
  entriesIn,
  entriesNamed,
  withoutCoveredLeaves,
} from "#core/catalog/catalog.ts";
import { withheldAt } from "#core/catalog/withheld.ts";
import { unmetEngine } from "#core/engines.ts";
import { kindDir, stagedLeaf } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { Ref } from "#core/ref.ts";
import { formatRef, isWholeNamespace, isWholeRegistry, refName, relativeTo } from "#core/ref.ts";
import type { Carried } from "./carries.ts";
import type {
  Acquired,
  Clash,
  Contained,
  Incompatible,
  Placement,
  PluginDocument,
  Selected,
  Warning,
} from "./model.ts";

export function addressOf(
  entry: Pick<Entry, "group" | "kind" | "name">,
  registry?: string,
): string {
  return [registry, entry.group, entry.kind, entry.name]
    .filter((part) => part !== undefined)
    .join("/");
}

/** A miss and its likely fix: the common mistake is a name written where a kind belongs. */
export function unmatched(ref: Ref, entries: readonly Entry[]): { message: string; guess: string } {
  const wanted = address(ref.name ?? ref.namespace);
  const shown = entries
    .filter((entry) => entry.name === wanted)
    .map((entry) => `\`${addressOf(entry, ref.registry)}\``)
    .sort();
  return {
    message: `${formatRef(ref)} matches nothing this registry publishes.`,
    guess: shown.length === 0 ? "" : `Did you mean ${list(shown, "or")}?`,
  };
}

const address = (segment: string | undefined): string | undefined =>
  segment === undefined ? undefined : sanitizeName(segment);

/** Whether a whole registry or namespace entry leaves this artifact out. */
export function excluded(ref: Ref, entry: Entry): boolean {
  if (ref.exclude === undefined) return false;
  const at = relativeTo(ref, { namespace: entry.group, kind: entry.kind, name: entry.name });
  return ref.exclude.includes(at);
}

export function candidates(ref: Ref, source: Acquired): Entry[] {
  const entries = source.catalog.entries;
  const kept = (found: Entry[]) => found.filter((entry) => !excluded(ref, entry));
  if (isWholeRegistry(ref)) return kept(withoutCoveredLeaves(entries));
  if (isWholeNamespace(ref)) return kept(inNamespace(ref.namespace as string, entries));
  const wanted = address(ref.name);
  // No kind means any kind but a plugin, which is addressed as its namespace. No namespace
  // means "wherever it is", which only answers when there is one.
  return (wanted === undefined ? [] : entriesNamed(entries, wanted)).filter(
    (entry) =>
      (ref.kind === undefined ? entry.kind !== "plugin" : entry.kind === ref.kind) &&
      entry.name === wanted &&
      (ref.namespace === undefined || entry.group === address(ref.namespace)),
  );
}

/** A namespace's members plus the plugin published for it, with no member landing twice. */
function inNamespace(namespace: string, entries: readonly Entry[]): Entry[] {
  const wanted = address(namespace);
  return withoutCoveredLeaves(
    entries.filter(
      (entry) => entry.group === wanted || (entry.kind === "plugin" && entry.name === wanted),
    ),
  );
}

export interface SelectOptions {
  manifest: Manifest;
  lock: Lock;
  acquired: readonly Acquired[];
  /** Absent, no artifact is checked against the aireg version it needs. */
  cliVersion?: string | undefined;
  /** By registry address, the name an artifact takes because another holds its own. */
  renames?: ReadonlyMap<string, string>;
}

export interface Selection {
  /** Sorted by installed name. */
  selected: Selected[];
  warnings: Warning[];
  incompatible: Incompatible[];
  clashes: Clash[];
  untrusted: Untrusted[];
}

/** A plugin left out because it carries what runs on its own, and nobody said yes to it. */
export interface Untrusted {
  name: string;
  registry: string;
  carries: readonly Carried[];
}

export function select({
  manifest,
  lock,
  acquired,
  cliVersion,
  renames = new Map(),
}: SelectOptions): Selection {
  const byAlias = new Map(acquired.map((entry) => [entry.alias, entry]));
  const chosen = new Map<string, Selected>();
  const byAddress = new Map<string, Selected>();
  const view: Choosing = {
    locked: lockedNames(lock),
    chosen,
    byAddress,
    cliVersion,
    renames,
    trusted: trustedIn(manifest),
  };
  const found: Omit<Selection, "selected"> = {
    warnings: [],
    incompatible: [],
    clashes: [],
    untrusted: [],
  };
  const take = (choice: Choice): void => {
    switch (choice.kind) {
      case "left":
        if (choice.warning !== undefined) found.warnings.push(choice.warning);
        if (choice.incompatible !== undefined) found.incompatible.push(choice.incompatible);
        if (choice.untrusted !== undefined) addUntrusted(found.untrusted, choice.untrusted);
        return;
      case "clash":
        found.clashes.push(choice.clash);
        return;
      case "again":
        reachedAgain(choice.ref, choice.reached, chosen);
        return;
      case "new":
        chosen.set(choice.selected.name, choice.selected);
        byAddress.set(addressKey(choice.ref.registry, choice.selected.path), choice.selected);
        return;
    }
  };

  for (const ref of manifest.artifacts) {
    const source = byAlias.get(ref.registry);
    if (source === undefined) continue;
    const matched = matching(ref, source);
    if (!Array.isArray(matched)) {
      if (matched !== undefined) found.warnings.push(matched);
      continue;
    }
    for (const entry of matched) take(choose(ref, source, entry, view));
  }
  return { selected: withoutCoveredMembers(chosen), ...found };
}

function matching(ref: Ref, source: Acquired): Entry[] | Warning | undefined {
  const found = candidates(ref, source);
  if (found.length === 0) {
    if (ref.exclude !== undefined) return undefined;
    // Published but withheld by status: what keeps or refuses it says why.
    if (withheldAt(source.catalog.withheld, { ...ref, group: ref.namespace }) !== undefined) {
      return undefined;
    }
    const { message, guess } = unmatched(ref, source.catalog.entries);
    return { name: undefined, message: guess === "" ? message : `${message} ${guess}` };
  }
  const clash = ambiguous(ref, found);
  return clash === undefined ? found : { name: undefined, message: clash };
}

/** A plugin places its members, so one also named on its own is not placed twice. */
function withoutCoveredMembers(chosen: ReadonlyMap<string, Selected>): Selected[] {
  const plugins = new Set(
    [...chosen.values()]
      .filter((item) => item.kind === "plugin")
      .map((item) => `${item.source}/${item.upstreamName}`),
  );
  return [...chosen.values()]
    .filter(
      (item) =>
        item.kind === "plugin" ||
        item.group === undefined ||
        !plugins.has(`${item.source}/${item.group}`),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which local name a source id was installed under, so a rename upstream follows, and by
 * address too: an id can carry its version, and a newer release keeps the name it had.
 */
function lockedNames(lock: Lock): Map<string, Map<string, string>> {
  const names = new Map<string, Map<string, string>>();
  for (const [localName, artifact] of Object.entries(lock.artifacts)) {
    // A row authored here has no upstream id yet, so nothing can be matched to
    // it by one; it is found by name until a publish assigns it one.
    if (artifact.id === undefined) continue;
    const source = names.get(artifact.registry) ?? new Map<string, string>();
    source.set(artifact.id, localName);
    if (artifact.address !== undefined) source.set(`\u0000${artifact.address}`, localName);
    names.set(artifact.registry, source);
  }
  return names;
}

function trustedIn(manifest: Manifest): Set<string> {
  return new Set(
    manifest.artifacts.flatMap((ref) =>
      (ref.trust ?? []).map((name) => addressKey(ref.registry, sanitizeName(name))),
    ),
  );
}

const addressKey = (registry: string, at: string): string => `${registry}\u0000${at}`;

/** Never a silent pick: choosing between two matches hides a skill that shares a command's name. */
function ambiguous(ref: Ref, found: readonly Entry[]): string | undefined {
  if (found.length < 2 || ref.name === undefined) return undefined;
  const shown = found.map((entry) => addressOf(entry, ref.registry)).sort();
  return `${formatRef(ref)} matches ${plural(found.length, "artifact")}: ${list(shown)}. Name one of them.`;
}

interface Choosing {
  /** By registry, the installed name each source id was locked under. */
  locked: ReadonlyMap<string, ReadonlyMap<string, string>>;
  chosen: ReadonlyMap<string, Selected>;
  /** The same selections by registry and path, so a second address for one is found at once. */
  byAddress: ReadonlyMap<string, Selected>;
  cliVersion: string | undefined;
  renames: ReadonlyMap<string, string>;
  /** Plugins a manifest entry trusts, by registry and name. */
  trusted: ReadonlySet<string>;
}

type Choice =
  | { kind: "left"; warning?: Warning; incompatible?: Incompatible; untrusted?: Untrusted }
  | { kind: "clash"; clash: Clash }
  /** Reached already through another address of the manifest's. */
  | { kind: "again"; ref: Ref; reached: Selected }
  | { kind: "new"; ref: Ref; selected: Selected };

function choose(ref: Ref, source: Acquired, entry: Entry, pass: Choosing): Choice {
  const { locked, chosen, byAddress, cliVersion, renames } = pass;
  if (cliVersion !== undefined && entry.engine !== undefined) {
    const needed = unmetEngine(cliVersion, entry.engine);
    if (needed !== undefined) {
      return {
        kind: "left",
        warning: { name: entry.name, message: `${quoted(entry.name)} ${needed}.` },
        ...(isWholeRegistry(ref)
          ? {}
          : { incompatible: { name: entry.name, engine: entry.engine } }),
      };
    }
  }
  const placement = source.placements.get(entry.path);
  if (placement === undefined) {
    return {
      kind: "left",
      warning: {
        name: entry.name,
        message: `${ref.registry} lists ${quoted(entry.name)} but serves no content for it.`,
      },
    };
  }
  const untrusted = needsTrust(ref, entry, placement, pass.trusted);
  if (untrusted !== undefined) return { kind: "left", untrusted };

  // Two addresses can reach one artifact, a namespace and a pin inside it, and
  // it installs once, under whichever the manifest wrote first.
  const reached = byAddress.get(addressKey(ref.registry, entry.path));
  if (reached !== undefined) return { kind: "again", ref, reached };
  const held = locked.get(ref.registry);
  const lockedName = held?.get(placement.id) ?? held?.get(`\u0000${entry.path}`);
  const name =
    ref.localName ??
    renames.get(addressOf(entry, ref.registry)) ??
    lockedName ??
    installedName(entry, ref, source);
  const existing = chosen.get(name);
  if (existing !== undefined) {
    const kept = addressOf({ ...existing, name: existing.upstreamName }, existing.source);
    return { kind: "clash", clash: { name, kept, dropped: addressOf(entry, ref.registry) } };
  }

  const selected: Selected = {
    name,
    kind: entry.kind,
    source: ref.registry,
    path: entry.path,
    id: placement.id,
    upstreamName: placement.name,
    contentId: placement.contentId,
    version: placement.version,
    contents:
      entry.kind === "plugin" ? contentsOf(entry, source.catalog.entries, placement.plugin) : [],
    ...(placement.plugin === undefined ? {} : { plugin: placement.plugin }),
    ...(placement.revision === undefined ? {} : { revision: placement.revision }),
    group: entry.group,
    targets: ref.targets,
    named: ref.name !== undefined,
    ...(ref.copy === true ? { copy: true } : {}),
    ...(ref.localName === undefined ? {} : { aliased: true }),
  };
  return { kind: "new", ref, selected };
}

/** A plugin from a source that is not a registry runs nothing until a person trusts it by name. */
function needsTrust(
  ref: Ref,
  entry: Entry,
  placement: Placement,
  trusted: ReadonlySet<string>,
): Untrusted | undefined {
  const carries = placement.plugin?.carries ?? [];
  if (entry.kind !== "plugin" || carries.length === 0) return undefined;
  if (trusted.has(addressKey(ref.registry, entry.name))) return undefined;
  return { name: entry.name, registry: ref.registry, carries };
}

function addUntrusted(untrusted: Untrusted[], plugin: Untrusted): void {
  if (!untrusted.some((item) => item.registry === plugin.registry && item.name === plugin.name)) {
    untrusted.push(plugin);
  }
}

/** Mutates the selection this pass made: it is the pass's own, not a caller's. */
function reachedAgain(ref: Ref, reached: Selected, chosen: Map<string, Selected>): void {
  // Named as well, it holds its version against a dependent like any named artifact.
  if (ref.name !== undefined) reached.named = true;
  // A name written with `as:` is the person's choice, wherever the entry sits.
  if (ref.localName !== undefined && !chosen.has(ref.localName)) {
    chosen.delete(reached.name);
    reached.name = ref.localName;
    chosen.set(reached.name, reached);
  }
}

/**
 * Whole-registry names include the namespace so two `lint`s stay two rows. A source that is not
 * a registry gives its namespaces itself, so its artifacts keep their plain names.
 */
function installedName(entry: Entry, ref: Ref, source: Acquired): string {
  if (ref.name !== undefined) return refName(ref);
  if (entry.group === undefined || isReadOnlyLayout(source.origin.layout)) return entry.name;
  return `${entry.group}/${entry.name}`;
}

/** Membership is the group, not a path prefix: a member is addressed by its own namespace. */
function contentsOf(
  plugin: Entry,
  entries: readonly Entry[],
  document: PluginDocument | undefined,
): Contained[] {
  const contents: Contained[] = [];
  for (const entry of entriesIn(entries, plugin.name)) {
    if (entry.kind === "plugin") continue;
    const leaf = stagedLeaf(entry.kind, entry.name, entry.path);
    contents.push({
      name: entry.name,
      kind: entry.kind,
      within: withinPlugin(plugin, entry) ?? `${kindDir(entry.kind)}${posix.sep}${leaf}`,
    });
  }
  // A target without plugins runs a command as a skill, named for its plugin.
  for (const command of document?.commands ?? []) {
    const name = sanitizeName(`${plugin.name}-${command.name}`);
    contents.push({ name, kind: "skill", within: command.path, command: true });
  }
  return contents;
}

/** Where a member sits in its plugin, when the source gives both as folders, one inside the other. */
function withinPlugin(plugin: Entry, member: Entry): string | undefined {
  const [outer, inner] = [plugin.from.pointer, member.from.pointer];
  if (plugin.from.file !== member.from.file || outer === "" || inner === "") return undefined;
  // A plugin that is one skill holds it at its own root.
  if (inner === outer) return "";
  if (outer === ".") return inner;
  return inner.startsWith(`${outer}/`) ? inner.slice(outer.length + 1) : undefined;
}
