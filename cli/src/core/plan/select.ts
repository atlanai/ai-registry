import { posix } from "node:path";
import { list, plural, quoted, sanitizeName } from "#adapter/text.ts";
import { type Entry, entriesIn, entriesNamed, withoutCoveredLeaves } from "#core/catalog/model.ts";
import { withheldAt } from "#core/catalog/withheld.ts";
import { kindDir, stagedLeaf } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import type { Ref } from "#core/ref.ts";
import { formatRef, isWholeNamespace, isWholeRegistry, refName, relativeTo } from "#core/ref.ts";
import { unmetEngine } from "#core/semver.ts";
import type { Acquired, Clash, Contained, Incompatible, Selected, Warning } from "./model.ts";

/**
 * Membership is the group, not a path prefix: upstream addresses a member by
 * its own namespace, so the plugin's address is not a prefix of it.
 */
function contentsOf(plugin: Entry, entries: readonly Entry[]): Contained[] {
  const contents: Contained[] = [];
  for (const entry of entriesIn(entries, plugin.name)) {
    if (entry.kind === "plugin") continue;
    const leaf = stagedLeaf(entry.kind, entry.name, entry.path);
    contents.push({
      name: entry.name,
      kind: entry.kind,
      within: `${kindDir(entry.kind)}${posix.sep}${leaf}`,
    });
  }
  return contents;
}

const address = (segment: string | undefined): string | undefined =>
  segment === undefined ? undefined : sanitizeName(segment);

/** Whole-registry names include the namespace so two `lint`s stay two rows. */
function installedName(entry: Entry, ref: Ref): string {
  if (ref.name !== undefined) return refName(ref);
  return entry.group === undefined ? entry.name : `${entry.group}/${entry.name}`;
}

/** The address that reaches this entry, through `registry` when one is given. */
export function addressOf(
  entry: Pick<Entry, "group" | "kind" | "name">,
  registry?: string,
): string {
  return [registry, entry.group, entry.kind, entry.name]
    .filter((part) => part !== undefined)
    .join("/");
}

/**
 * What a reference that matches nothing says, and the addresses with its name: the
 * commonest way to get one wrong is a name written where a kind belongs.
 */
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

/**
 * A namespace holds the artifacts grouped under it, plus the plugin the source
 * publishes for it; `withoutCoveredLeaves` keeps a member from landing twice.
 */
function inNamespace(namespace: string, entries: readonly Entry[]): Entry[] {
  const wanted = address(namespace);
  return withoutCoveredLeaves(
    entries.filter(
      (entry) => entry.group === wanted || (entry.kind === "plugin" && entry.name === wanted),
    ),
  );
}

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
  return (wanted === undefined ? [] : entriesNamed(entries, wanted)).filter(
    (entry) =>
      // No kind written means any kind but a plugin, which is addressed as its namespace.
      (ref.kind === undefined ? entry.kind !== "plugin" : entry.kind === ref.kind) &&
      entry.name === wanted &&
      // An address that names no namespace means "wherever it is", which is
      // only an answer when there is one.
      (ref.namespace === undefined || entry.group === address(ref.namespace)),
  );
}

/** Never a silent pick: choosing between two matches hides a skill that shares a command's name. */
function ambiguous(ref: Ref, found: readonly Entry[]): string | undefined {
  if (found.length < 2 || ref.name === undefined) return undefined;
  const shown = found.map((entry) => addressOf(entry, ref.registry)).sort();
  return `${formatRef(ref)} matches ${plural(found.length, "artifact")}: ${list(shown)}. Name one of them.`;
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

/** What one `select` pass reads and fills in as it chooses entries. */
interface Choosing {
  /** By registry, the installed name each source id was locked under. */
  locked: ReadonlyMap<string, ReadonlyMap<string, string>>;
  chosen: Map<string, Selected>;
  /** The same selections by registry and path, so a second address for one is found at once. */
  byAddress: Map<string, Selected>;
  warnings: Warning[];
  cliVersion: string | undefined;
  incompatible: Incompatible[];
  clashes: Clash[];
  /** By registry address, the name an artifact takes because another holds its own. */
  renames: ReadonlyMap<string, string>;
}

function choose(ref: Ref, source: Acquired, entry: Entry, pass: Choosing): void {
  const { locked, chosen, byAddress, warnings, cliVersion, incompatible, clashes, renames } = pass;
  if (cliVersion !== undefined && entry.engine !== undefined) {
    const needed = unmetEngine(cliVersion, entry.engine);
    if (needed !== undefined) {
      warnings.push({ name: entry.name, message: `${quoted(entry.name)} ${needed}.` });
      if (!isWholeRegistry(ref)) incompatible.push({ name: entry.name, engine: entry.engine });
      return;
    }
  }
  const placement = source.placements.get(entry.path);
  if (placement === undefined) {
    warnings.push({
      name: entry.name,
      message: `${ref.registry} lists ${quoted(entry.name)} but serves no content for it.`,
    });
    return;
  }

  // Two addresses can reach one artifact, a namespace and a pin inside it, and
  // it installs once, under whichever the manifest wrote first.
  const reached = byAddress.get(`${ref.registry}\u0000${entry.path}`);
  if (reached !== undefined) {
    // Named as well, it holds its version against a dependent like any named artifact.
    if (ref.name !== undefined) reached.named = true;
    // A name written with `as:` is the person's choice, wherever the entry sits.
    if (ref.localName !== undefined && !chosen.has(ref.localName)) {
      chosen.delete(reached.name);
      reached.name = ref.localName;
      chosen.set(reached.name, reached);
    }
    return;
  }
  const held = locked.get(ref.registry);
  const lockedName = held?.get(placement.id) ?? held?.get(`\u0000${entry.path}`);
  const name =
    ref.localName ??
    renames.get(addressOf(entry, ref.registry)) ??
    lockedName ??
    installedName(entry, ref);
  const existing = chosen.get(name);
  if (existing !== undefined) {
    const kept = addressOf({ ...existing, name: existing.upstreamName }, existing.source);
    clashes.push({ name, kept, dropped: addressOf(entry, ref.registry) });
    return;
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
    contents: entry.kind === "plugin" ? contentsOf(entry, source.catalog.entries) : [],
    group: entry.group,
    targets: ref.targets,
    named: ref.name !== undefined,
    ...(ref.copy === true ? { copy: true } : {}),
    ...(ref.localName === undefined ? {} : { aliased: true }),
  };
  chosen.set(name, selected);
  byAddress.set(`${ref.registry}\u0000${entry.path}`, selected);
}

export function select(
  manifest: Manifest,
  lock: Lock,
  acquired: readonly Acquired[],
  warnings: Warning[],
  cliVersion?: string,
  incompatible: Incompatible[] = [],
  clashes: Clash[] = [],
  renames: ReadonlyMap<string, string> = new Map(),
): Selected[] {
  const byAlias = new Map(acquired.map((entry) => [entry.alias, entry]));
  const chosen = new Map<string, Selected>();
  const pass: Choosing = {
    locked: lockedNames(lock),
    chosen,
    byAddress: new Map(),
    warnings,
    cliVersion,
    incompatible,
    clashes,
    renames,
  };

  for (const ref of manifest.artifacts) {
    const source = byAlias.get(ref.registry);
    if (source === undefined) continue;
    const found = candidates(ref, source);
    if (found.length === 0) {
      if (ref.exclude !== undefined) continue;
      // Published but withheld by status: what keeps or refuses it says why.
      if (withheldAt(source.catalog.withheld, { ...ref, group: ref.namespace }) !== undefined) {
        continue;
      }
      const { message, guess } = unmatched(ref, source.catalog.entries);
      warnings.push({ name: undefined, message: guess === "" ? message : `${message} ${guess}` });
      continue;
    }
    const clash = ambiguous(ref, found);
    if (clash !== undefined) {
      warnings.push({ name: undefined, message: clash });
      continue;
    }
    for (const entry of found) choose(ref, source, entry, pass);
  }

  // A plugin already places everything inside it, so a member asked for by name
  // as well is dropped rather than projected a second time under its own.
  const plugins = new Set(
    [...chosen.values()]
      .filter((item) => item.kind === "plugin")
      .map((item) => `${item.source}/${item.upstreamName}`),
  );
  for (const [name, item] of chosen) {
    if (item.kind === "plugin" || item.group === undefined) continue;
    if (plugins.has(`${item.source}/${item.group}`)) chosen.delete(name);
  }

  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
