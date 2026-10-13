import { dirname, join, posix, resolve } from "node:path";
import { sanitizeName } from "#adapter/text.ts";
import { posixRelative } from "#core/fs/path.ts";
import type { Render } from "#core/harness/contract.ts";
import {
  type Harnesses,
  placementFor,
  pluginProjection,
  projectionPath,
  readsFor,
  takesPlugin,
} from "#core/harness/index.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import { namespaceDir, projectionDir, type Scope } from "#core/store/paths.ts";
import type { Selected } from "./model.ts";

export interface ProjectionOptions {
  roots: {
    base: string;
    cwd: string;
    scope: Scope;
    artifacts: string;
  };
  targets: readonly string[];
  harnesses: Harnesses;
}

export interface PlannedLink {
  /** Harness name, the same concept the lock records on a link. */
  harness: string;
  absolute: string;
  relative: string;
  from: string;
  /** A plugin directory is shared by every artifact in its namespace. */
  shared?: boolean;
  /** The content the projection links to, when this link is a projection. */
  content?: string;
  /** Placed as a real directory of links, for a harness that will not load a linked plugin. */
  fan?: boolean;
  /** The plugin name, when it had to differ from the namespace it holds. */
  renamed?: { namespace: string; name: string };
  /** Written in the harness's own format. */
  render?: Render;
}

function plannedLink(
  name: string,
  path: string,
  from: string,
  options: ProjectionOptions,
  kind?: ArtifactKind,
): PlannedLink {
  const render = kind === undefined ? undefined : options.harnesses[name]?.kinds[kind]?.render;
  return {
    harness: name,
    absolute: path,
    relative: posixRelative(options.roots.base, path),
    from,
    ...(render === undefined ? {} : { render }),
  };
}

/**
 * A plugin artifact is its own; anything else wrapped joins the plugin its namespace
 * becomes, or the registry's when it publishes no namespaces.
 */
export function namespaceOf(item: Pick<Selected, "kind" | "name" | "group" | "source">): string {
  if (item.kind === "plugin") return item.name;
  return item.group ?? item.source;
}

/** One registry's namespace, as a harness would hold it. */
export interface NamespaceWant {
  harness: string;
  namespace: string;
  source: string;
}

/**
 * Plugin directories more than one registry wants. A harness that does not
 * key them by registry would load one namespace and hide the other.
 */
export function crowdedContainers(
  wants: Iterable<NamespaceWant>,
  options: Pick<ProjectionOptions, "roots" | "harnesses">,
): Set<string> {
  const { scope, cwd } = options.roots;
  const sources = new Map<string, Set<string>>();
  for (const want of wants) {
    const target = options.harnesses[want.harness];
    if (target === undefined || !takesPlugin(target, scope)) continue;
    const container = pluginProjection(
      target,
      want.namespace,
      scope,
      cwd,
      process.env,
      want.source,
    );
    if (container === undefined) continue;
    const found = sources.get(container) ?? new Set<string>();
    found.add(want.source);
    sources.set(container, found);
  }
  return new Set([...sources].filter(([, found]) => found.size > 1).map(([path]) => path));
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

/**
 * Installed artifacts whose plugin link is not where the naming rule puts it, because another
 * registry's namespace started or stopped sharing it. Read from the lock alone, without planning.
 */
export function movedPluginLinks(
  lock: Lock,
  options: Pick<ProjectionOptions, "roots" | "harnesses">,
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
      [...new Set(entry.links.map((link) => link.harness))].map((harness) => ({
        harness,
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
  link: { harness: string; path: string },
  namespace: string,
  source: string,
  options: Pick<ProjectionOptions, "roots" | "harnesses">,
): { bare: string; qualified: string } | undefined {
  const { scope, cwd, base } = options.roots;
  const target = options.harnesses[link.harness];
  if (target === undefined || !takesPlugin(target, scope)) return undefined;
  const bare = pluginProjection(target, namespace, scope, cwd, process.env, source);
  const qualified = pluginProjection(
    target,
    qualifiedName(source, namespace),
    scope,
    cwd,
    process.env,
    source,
  );
  if (bare === undefined || qualified === undefined) return undefined;
  const at = resolve(base, link.path);
  return at === bare || at === qualified ? { bare, qualified } : undefined;
}

type Unreadable = (harness: string, kind: ArtifactKind) => void;

/**
 * A harness that loads plugins is pointed at the whole namespace: one entry in a
 * directory we do not own, holding the layout it already reads.
 */
function pluginLink(
  item: Selected,
  name: string,
  target: Harnesses[string],
  options: ProjectionOptions,
  crowded: ReadonlySet<string>,
): PlannedLink | undefined {
  const { scope, cwd } = options.roots;
  const namespace = namespaceOf(item);
  const shared = pluginProjection(target, namespace, scope, cwd, process.env, item.source);
  if (shared === undefined) return undefined;
  // Every registry sharing the directory takes its alias as a prefix, so
  // no one of them depends on which the others sync first.
  const plugin = crowded.has(shared) ? qualifiedName(item.source, namespace) : namespace;
  const container =
    plugin === namespace
      ? shared
      : pluginProjection(target, plugin, scope, cwd, process.env, item.source);
  if (container === undefined) return undefined;
  // Always the assembled projection, never the content: the content tree holds
  // no manifests. Its directory name is the plugin name.
  const dir = projectionDir(options.roots, item.source, plugin);
  return {
    ...plannedLink(name, container, dir, options),
    shared: true,
    content: namespaceDir(options.roots, item.source, namespace),
    ...(target.kinds.plugin?.place === "fan" ? { fan: true } : {}),
    ...(plugin === namespace ? {} : { renamed: { namespace, name: plugin } }),
  };
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
  const { scope, cwd } = options.roots;
  const links: PlannedLink[] = [];
  const rest: string[] = [];
  for (const name of selected) {
    const target = options.harnesses[name];
    if (target === undefined) continue;
    if (!takesPlugin(target, scope)) {
      rest.push(name);
      continue;
    }
    const link = pluginLink(item, name, target, options, crowded);
    if (link !== undefined) links.push(link);
  }
  for (const kind of new Set(item.contents.map((leaf) => leaf.kind))) {
    const placed = placementFor(kind, rest, options.harnesses, scope, true);
    for (const harness of placed.unreadable) onUnreadable(harness, kind);
    for (const name of placed.targets) {
      const target = options.harnesses[name] as Harnesses[string];
      for (const leaf of item.contents.filter((each) => each.kind === kind)) {
        const path = projectionPath(target, leaf.kind, leaf.name, scope, cwd);
        if (path === undefined) continue;
        const from = join(copy, ...leaf.within.split(posix.sep));
        links.push(plannedLink(name, path, from, options, leaf.kind));
      }
    }
  }
  return links;
}

/**
 * A plugin installs as one, and so does a namespace whose source wraps it; anything else
 * is placed as itself, in the fewest folders that reach every harness able to read its kind.
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

  const { scope, cwd } = options.roots;
  const links: PlannedLink[] = [];
  const rest: string[] = [];
  for (const name of new Set(selected)) {
    const target = options.harnesses[name];
    if (target === undefined) continue;
    // Its plugins carry only kinds it maps unrendered; the rest are placed flat or not at all.
    const mapping = target.kinds[item.kind];
    if (!wrapped || !takesPlugin(target, scope) || mapping === undefined || mapping.render) {
      rest.push(name);
      continue;
    }
    const link = pluginLink(item, name, target, options, crowded);
    if (link !== undefined) links.push(link);
  }
  const placed = placementFor(item.kind, rest, options.harnesses, scope, wrapped);
  for (const harness of placed.unreadable) onUnreadable(harness, item.kind);
  for (const name of placed.targets) {
    const target = options.harnesses[name] as Harnesses[string];
    const own = projectionPath(target, item.kind, item.name, scope, cwd);
    if (own !== undefined) links.push(plannedLink(name, own, copy, options, item.kind));
  }
  return links;
}

export function claim(
  links: readonly PlannedLink[],
  name: string,
  claimed: Map<string, string>,
  collided: (owner: string, link: PlannedLink) => void,
): PlannedLink[] {
  const kept: PlannedLink[] = [];
  for (const link of links) {
    const owner = claimed.get(link.absolute);
    // A plugin directory is shared on purpose: every artifact in the namespace
    // keeps it, so removing one sibling never unlinks the plugin the rest need.
    if (link.shared === true) {
      claimed.set(link.absolute, name);
      kept.push(link);
      continue;
    }
    if (owner !== undefined && owner !== name) {
      collided(owner, link);
      continue;
    }
    claimed.set(link.absolute, name);
    kept.push(link);
  }
  return kept;
}

/**
 * The folders a harness would load these items from, were it picked beside `chosen`:
 * the plugin directory it takes them in, else the first folder it reads each kind from.
 */
export function loadsFrom(
  harness: string,
  chosen: readonly string[],
  items: readonly Selected[],
  options: Pick<ProjectionOptions, "roots" | "harnesses">,
  wrapped = false,
): string[] {
  const targets = [...new Set([...chosen, harness])];
  const folders = items.flatMap((item) => {
    const links = linksFor(item, "", { ...options, targets }, wrapped);
    const own = links.find((link) => link.harness === harness);
    if (own !== undefined) return [own.shared === true ? own.absolute : dirname(own.absolute)];
    const read = readsFor(options.harnesses, harness, item.kind)
      .map((folder) => links.find((link) => link.harness === folder && link.shared !== true))
      .find((link) => link !== undefined);
    return read === undefined ? [] : [dirname(read.absolute)];
  });
  return [...new Set(folders)];
}
