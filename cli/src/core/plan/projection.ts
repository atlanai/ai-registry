import { dirname, join, posix, resolve } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { sanitizeName } from "#adapter/text.ts";
import { posixRelative } from "#core/fs/path.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { namespaceDir, projectionDir, type Scope, type Where } from "#core/store/paths.ts";
import type { Codec, Targets } from "#core/target/contract.ts";
import { placementFor, readsFor, takesPlugin } from "#core/target/placement.ts";
import { pluginProjection, projectionPath } from "#core/target/roots.ts";
import type { KeyRule, PluginDocument, Selected } from "./model.ts";

export interface ProjectionOptions {
  roots: {
    base: string;
    cwd: string;
    scope: Scope;
    artifacts: string;
  };
  /** Read for a target's own folder variables. */
  env: NodeJS.ProcessEnv;
  targets: readonly string[];
  targetTable: Targets;
}

/** A scope's projection without a run's choice of targets: enough to say where a link lands. */
export type ProjectionScope = Pick<ProjectionOptions, "roots" | "env" | "targetTable">;

export interface PlannedLink {
  target: string;
  absolute: string;
  relative: string;
  from: string;
  /** A plugin directory is shared by every artifact in its namespace. */
  shared?: boolean;
  /** Present when this link is a projection: the content it links to. */
  content?: string;
  /** Placed as a real directory of links, for a target that will not load a linked plugin. */
  fan?: boolean;
  /** The plugin name, when it had to differ from the namespace it holds. */
  renamed?: { namespace: string; name: string };
  codec?: Codec;
  entry?: string;
  /** Written as a real copy, for a target that rewrites or refuses links. */
  copy?: boolean;
  command?: string;
  document?: PluginDocument;
  part?: ArtifactKind;
  keys?: Record<string, KeyRule>;
}

function whereOf({ roots, env }: Pick<ProjectionOptions, "roots" | "env">): Where {
  return { scope: roots.scope, cwd: roots.cwd, env };
}

/** A plugin is its own; anything else joins its namespace's plugin, or the registry's. */
export function namespaceOf(item: Pick<Selected, "kind" | "name" | "group" | "source">): string {
  if (item.kind === "plugin") return item.name;
  return item.group ?? item.source;
}

/**
 * Plugin directories two registries' namespaces want under a bare name, repeated until no
 * qualified name lands on another's bare name; equal qualified names are left to clash in claim().
 */
export function crowdedContainers(
  wants: Iterable<NamespaceWant>,
  options: ProjectionScope,
): Set<string> {
  const where = whereOf(options);
  const places: { bare: string; qualified: string | undefined; owner: string }[] = [];
  for (const want of wants) {
    const target = options.targetTable[want.target];
    if (target === undefined || !takesPlugin(target, where.scope)) continue;
    const at = (name: string) => pluginProjection(target, name, where, want.source);
    const bare = at(want.namespace);
    if (bare === undefined) continue;
    const qualified = at(qualifiedName(want.source, want.namespace));
    places.push({ bare, qualified, owner: JSON.stringify([want.source, want.namespace]) });
  }
  const crowded = new Set<string>();
  for (let grew = true; grew; ) {
    const owners = new Map<string, Set<string>>();
    for (const place of places) {
      const at = crowded.has(place.bare) ? place.qualified : place.bare;
      if (at === undefined) continue;
      owners.set(at, (owners.get(at) ?? new Set()).add(place.owner));
    }
    grew = false;
    for (const place of places) {
      if (crowded.has(place.bare) || (owners.get(place.bare)?.size ?? 0) < 2) continue;
      crowded.add(place.bare);
      grew = true;
    }
  }
  return crowded;
}

/** What a namespace is called where another registry's namespace shares its name. */
function qualifiedName(source: string, namespace: string): string {
  return sanitizeName(`${source}-${namespace}`);
}

/** Every projection a row may be linked through: its namespace's, bare and qualified. */
export function projectionsOf(
  lock: Lock,
  roots: Pick<ProjectionOptions["roots"], "artifacts">,
): Set<string> {
  const dirs = new Set<string>();
  for (const [name, entry] of Object.entries(lock.artifacts)) {
    const source = entry.registry;
    const namespace = namespaceOf({ kind: entry.kind, name, group: entry.namespace, source });
    for (const plugin of [namespace, qualifiedName(source, namespace)]) {
      dirs.add(projectionDir(roots, source, plugin));
    }
  }
  return dirs;
}

export interface NamespaceWant {
  target: string;
  namespace: string;
  source: string;
}

/**
 * Installed artifacts whose plugin link is not where the naming rule puts it, because another
 * registry's namespace started or stopped sharing it. Read from the lock alone, without planning.
 */
export function movedPluginLinks(
  lock: Lock,
  options: ProjectionScope,
  opened?: ReadonlySet<string>,
): Set<string> {
  const { base } = options.roots;
  const rows = Object.entries(lock.artifacts).map(([name, entry]) => ({
    name,
    entry,
    namespace: namespaceOf({
      kind: entry.kind,
      name,
      group: entry.namespace,
      source: entry.registry,
    }),
  }));
  const crowded = crowdedContainers(
    rows.flatMap(({ entry, namespace }) =>
      [...new Set(entry.links.map((link) => link.target))].map((target) => ({
        target,
        namespace,
        source: entry.registry,
      })),
    ),
    options,
  );
  const moved = new Set<string>();
  for (const { name, entry, namespace } of rows) {
    if (opened !== undefined && !opened.has(entry.registry)) continue;
    for (const link of entry.links) {
      const at = pluginLinkAt(link, namespace, entry.registry, options);
      // Only the namespace's own plugin link can move; any other link stays put.
      if (at === undefined) continue;
      if (resolve(base, link.path) !== (crowded.has(at.bare) ? at.qualified : at.bare)) {
        moved.add(name);
      }
    }
  }
  return moved;
}

/** Where a recorded link sits, when it is a namespace's plugin directory under either name. */
export function pluginLinkAt(
  link: { target: string; path: string },
  namespace: string,
  source: string,
  options: ProjectionScope,
): { bare: string; qualified: string } | undefined {
  const where = whereOf(options);
  const target = options.targetTable[link.target];
  if (target === undefined || !takesPlugin(target, where.scope)) return undefined;
  const bare = pluginProjection(target, namespace, where, source);
  const qualified = pluginProjection(target, qualifiedName(source, namespace), where, source);
  if (bare === undefined || qualified === undefined) return undefined;
  const at = resolve(options.roots.base, link.path);
  return at === bare || at === qualified ? { bare, qualified } : undefined;
}

/** The namespace content a lockfile row's link holds as its plugin, if it is one. */
export function rowPlugin(
  name: string,
  entry: LockArtifact,
  link: { target: string; path: string },
  options: ProjectionScope,
): string | undefined {
  const source = entry.registry;
  const namespace = namespaceOf({ kind: entry.kind, name, group: entry.namespace, source });
  if (pluginLinkAt(link, namespace, source, options) === undefined) return undefined;
  return namespaceDir(options.roots, source, namespace);
}

/**
 * A plugin installs as one, and so does a namespace whose source wraps it; anything else
 * is placed as itself, in the fewest folders that reach every target able to read its kind.
 */
export function linksFor(
  item: Selected,
  copy: string,
  options: ProjectionOptions,
  wrapped = false,
  crowded: ReadonlySet<string> = new Set(),
  onUnreadable: Unreadable = () => undefined,
): PlannedLink[] {
  const selected = item.targets ?? options.targets;
  if (item.kind === "plugin") {
    return pluginLinks(item, copy, selected, options, crowded, onUnreadable);
  }

  const where = whereOf(options);
  const links: PlannedLink[] = [];
  const rest: string[] = [];
  for (const name of new Set(selected)) {
    const target = options.targetTable[name];
    if (target === undefined) continue;
    // Its plugins carry only kinds it places as they are; the rest are placed flat or not at all.
    const mapping = target.kinds[item.kind];
    const written = mapping?.codec !== undefined || mapping?.entry !== undefined;
    if (!wrapped || !takesPlugin(target, where.scope) || mapping === undefined || written) {
      rest.push(name);
      continue;
    }
    const link = pluginLink(item, name, target, options, crowded);
    if (link !== undefined) links.push(link);
  }
  const placed = placementFor(item.kind, rest, {
    targetTable: options.targetTable,
    where,
    wrapped,
  });
  for (const target of placed.unreadable) onUnreadable(target, item.kind);
  for (const name of placed.targets) {
    const target = options.targetTable[name] as Targets[string];
    const own = projectionPath(target, item.kind, item.name, where);
    if (own === undefined) continue;
    links.push({
      ...plannedLink(name, own, copy, options, item.kind),
      ...copyAt(name, item.kind, selected, options.targetTable, where),
      ...keysAt(name, item.kind, selected, options.targetTable, where),
    });
  }
  return links;
}

/** Tools that load plugins get the container; the rest get its members where they read each kind. */
function pluginLinks(
  item: Selected,
  copy: string,
  selected: readonly string[],
  options: ProjectionOptions,
  crowded: ReadonlySet<string>,
  onUnreadable: Unreadable,
): PlannedLink[] {
  const where = whereOf(options);
  const links: PlannedLink[] = [];
  const rest: string[] = [];
  for (const name of selected) {
    const target = options.targetTable[name];
    if (target === undefined) continue;
    if (!takesPlugin(target, where.scope)) {
      rest.push(name);
      continue;
    }
    const link = pluginLink(item, name, target, options, crowded);
    if (link !== undefined) links.push(link);
  }
  for (const kind of new Set(item.contents.map((leaf) => leaf.kind))) {
    const placed = placementFor(kind, rest, {
      targetTable: options.targetTable,
      where,
      wrapped: true,
    });
    for (const target of placed.unreadable) onUnreadable(target, kind);
    for (const name of placed.targets) {
      const target = options.targetTable[name] as Targets[string];
      for (const leaf of item.contents.filter((each) => each.kind === kind)) {
        const path = projectionPath(target, leaf.kind, leaf.name, where);
        if (path === undefined) continue;
        const from = join(copy, ...leaf.within.split(posix.sep));
        const link = {
          ...plannedLink(name, path, from, options, leaf.kind),
          ...copyAt(name, leaf.kind, selected, options.targetTable, where),
          ...keysAt(name, leaf.kind, selected, options.targetTable, where),
          part: leaf.kind,
        };
        // A skill is a folder, so the command is written as one holding its SKILL.md.
        links.push(
          leaf.command === true ? { ...link, entry: SKILL_ENTRY, command: leaf.name } : link,
        );
      }
    }
  }
  return links;
}

/** A target that loads plugins gets one entry for the whole namespace, in a folder we do not own. */
function pluginLink(
  item: Selected,
  name: string,
  target: Targets[string],
  options: ProjectionOptions,
  crowded: ReadonlySet<string>,
): PlannedLink | undefined {
  const where = whereOf(options);
  const namespace = namespaceOf(item);
  const shared = pluginProjection(target, namespace, where, item.source);
  if (shared === undefined) return undefined;
  // Every registry sharing the directory takes its alias as a prefix, so
  // no one of them depends on which the others sync first.
  const plugin = crowded.has(shared) ? qualifiedName(item.source, namespace) : namespace;
  const container =
    plugin === namespace ? shared : pluginProjection(target, plugin, where, item.source);
  if (container === undefined) return undefined;
  // Always the assembled projection, never the content: the content tree holds
  // no manifests. Its directory name is the plugin name.
  const dir = projectionDir(options.roots, item.source, plugin);
  return {
    ...plannedLink(name, container, dir, options),
    shared: true,
    content: namespaceDir(options.roots, item.source, namespace),
    ...(item.plugin === undefined ? {} : { document: item.plugin }),
    ...(target.kinds.plugin?.place === "fan" ? { fan: true } : {}),
    ...(target.kinds.plugin?.place === "copy" ? { copy: true } : {}),
    ...(plugin === namespace ? {} : { renamed: { namespace, name: plugin } }),
  };
}

type Unreadable = (target: string, kind: ArtifactKind) => void;

function plannedLink(
  name: string,
  path: string,
  from: string,
  options: ProjectionOptions,
  kind?: ArtifactKind,
): PlannedLink {
  const mapping = kind === undefined ? undefined : options.targetTable[name]?.kinds[kind];
  return {
    target: name,
    absolute: path,
    relative: posixRelative(options.roots.base, path),
    from,
    ...(mapping?.codec === undefined ? {} : { codec: mapping.codec }),
    ...(mapping?.entry === undefined ? {} : { entry: mapping.entry }),
    ...(mapping?.place === "copy" ? { copy: true } : {}),
  };
}

/** Copies, when any selected target that reads `folder` takes this kind as copies. */
function copyAt(
  folder: string,
  kind: ArtifactKind,
  selected: readonly string[],
  targetTable: Targets,
  where: Where,
): { copy?: true } {
  const copied = [...new Set(selected)].some(
    (reader) =>
      targetTable[reader]?.kinds[kind]?.place === "copy" &&
      readsFor(targetTable, reader, kind, where).includes(folder),
  );
  return copied ? { copy: true } : {};
}

function keysAt(
  folder: string,
  kind: ArtifactKind,
  selected: readonly string[],
  targetTable: Targets,
  where: Where,
): { keys?: Record<string, KeyRule> } {
  const keys: Record<string, KeyRule> = {};
  for (const reader of new Set(selected)) {
    if (!readsFor(targetTable, reader, kind, where).includes(folder)) continue;
    const target = targetTable[reader];
    for (const [key, how] of Object.entries(target?.kinds[kind]?.keys ?? {})) {
      const rule = keys[key] ?? { files: [], refusedBy: [] };
      keys[key] = rule;
      if (how === false) rule.refusedBy.push(target?.displayName ?? reader);
      else if (!rule.files.some((file) => file.path === how.path)) rule.files.push(how);
    }
  }
  return Object.keys(keys).length === 0 ? {} : { keys };
}

/**
 * Takes the paths no other artifact holds. `plugins` names, by the content each links, the
 * namespace whose plugin holds a directory: only that namespace's artifacts share it.
 */
export function claim(
  links: readonly PlannedLink[],
  name: string,
  claimed: Map<string, string>,
  plugins: Map<string, string>,
  collided: (owner: string, link: PlannedLink) => void,
): PlannedLink[] {
  const kept: PlannedLink[] = [];
  for (const link of links) {
    const owner = claimed.get(link.absolute);
    // A plugin directory is shared on purpose: every artifact in the namespace keeps it, so
    // removing one sibling never unlinks the plugin the rest need. Anything else holding it collides.
    const plugin = plugins.get(link.absolute);
    const sibling = link.shared === true && plugin !== undefined && plugin === link.content;
    if (owner !== undefined && owner !== name && !sibling) {
      collided(owner, link);
      continue;
    }
    claimed.set(link.absolute, name);
    if (link.shared === true && link.content !== undefined) {
      plugins.set(link.absolute, link.content);
    } else plugins.delete(link.absolute);
    kept.push(link);
  }
  return kept;
}

/**
 * The folders a target would load these items from, were it picked beside `chosen`:
 * the plugin directory it takes them in, else the first folder it reads each kind from.
 */
export function loadsFrom(
  target: string,
  chosen: readonly string[],
  items: readonly Selected[],
  options: ProjectionScope,
  wrapped = false,
): string[] {
  const targets = [...new Set([...chosen, target])];
  const folders = items.flatMap((item) => {
    const links = linksFor(item, "", { ...options, targets }, wrapped);
    const own = links.find((link) => link.target === target);
    if (own !== undefined) return [own.shared === true ? own.absolute : dirname(own.absolute)];
    const read = readsFor(options.targetTable, target, item.kind, whereOf(options))
      .map((folder) => links.find((link) => link.target === folder && link.shared !== true))
      .find((link) => link !== undefined);
    return read === undefined ? [] : [dirname(read.absolute)];
  });
  return [...new Set(folders)];
}
