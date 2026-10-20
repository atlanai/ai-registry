import { posix } from "node:path";
import type { Artifact } from "../contract.ts";
import { SpecError } from "../filespec/documents.ts";
import { list, quoted } from "../text.ts";
import { ROOT_ID } from "./folder.ts";
import type { FetchedPlugin, Found, Layout, LayoutContext, RemotePlugin } from "./layout.ts";
import { type Json, pluginManifest, readObject, readPlugin } from "./plugin.ts";
import { openTree, type Tree } from "./tree.ts";

/** Claude Code's marketplace, then Codex's, which aireg reads when the first is not there. */
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

interface Marketplace {
  path: string;
  name: string;
  entries: Json[];
  /** Where a bare plugin source resolves, from `metadata.pluginRoot`. */
  pluginRoot: string | undefined;
}

/** A marketplace as its format requires it: Claude Code's needs an owner, Codex's does not. */
async function readMarketplace(tree: Tree, path: string): Promise<Marketplace | undefined> {
  const document = await readObject(tree, path);
  if (document === undefined) return undefined;
  const name = textOf(document.name);
  const owner = isRecord(document.owner) ? textOf(document.owner.name) : undefined;
  const claude = path === MARKETPLACES[0];
  if (name === undefined || !Array.isArray(document.plugins) || (claude && owner === undefined)) {
    const needs = claude ? "`name`, `owner.name` and `plugins`" : "`name` and `plugins`";
    throw new SpecError(`${path} needs ${needs}.`, { path });
  }
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  return {
    path,
    name,
    entries: document.plugins.filter(isRecord),
    pluginRoot: textOf(metadata.pluginRoot),
  };
}

/** A relative path inside the marketplace, `./x` from its root; undefined for one that leaves it. */
function relative(path: string): string | undefined {
  if (path === "." || path === "./") return "";
  if (!path.startsWith("./") || path.includes("\\")) return undefined;
  const rest = posix.normalize(path.slice(2)).replace(/\/+$/, "");
  if (rest === "." || rest === "") return "";
  return rest === ".." || rest.startsWith("../") ? undefined : rest;
}

/** Where an entry's plugin lives in this source, or why aireg leaves it out. */
/** Sources aireg fetches with git, which take a `ref` and a `sha`. */
const FETCHED = new Set(["github", "url", "git-subdir"]);

/** A commit, as Claude Code takes one: forty lowercase hex characters. */
const SHA = /^[0-9a-f]{40}$/;

/** A source fetched from elsewhere, read from the entry; a sha that is not a commit is an error. */
function remoteOf(name: string, source: Json, path: string): RemotePlugin | undefined {
  const type = textOf(source.source);
  if (type === undefined || !FETCHED.has(type)) return undefined;
  const location = textOf(type === "github" ? source.repo : source.url);
  if (location === undefined) return undefined;
  const sha = textOf(source.sha);
  if (sha !== undefined && !SHA.test(sha)) {
    throw new SpecError(
      `${path} gives ${quoted(name)} the sha ${quoted(sha)}, which is not a full commit: it takes 40 lowercase hex characters.`,
      { path },
    );
  }
  return { name, type, location, path: textOf(source.path), ref: textOf(source.ref), sha };
}

type Located = { dir: string } | { remote: RemotePlugin } | { skip: string };

function sourceOf(entry: Json, name: string, marketplace: Marketplace): Located {
  const pluginRoot = marketplace.pluginRoot;
  const source =
    isRecord(entry.source) && entry.source.source === "local" ? entry.source.path : entry.source;
  if (typeof source === "string") {
    if (!source.includes("/") && source !== "." && pluginRoot !== undefined) {
      const root = relative(pluginRoot);
      if (root !== undefined) return { dir: root === "" ? source : `${root}/${source}` };
    }
    const dir = relative(source);
    return dir === undefined
      ? { skip: `its source, ${quoted(source)}, is not a folder inside the marketplace` }
      : { dir };
  }
  const remote = isRecord(source) ? remoteOf(name, source, marketplace.path) : undefined;
  if (remote !== undefined) return { remote };
  const type = isRecord(source) ? textOf(source.source) : undefined;
  return { skip: `its ${type === undefined ? "" : `${type} `}source is not one aireg reads` };
}

/** A plugin from elsewhere, read from its own folder, with ids kept apart from the marketplace's. */
async function fetchedPlugin(
  remote: RemotePlugin,
  entry: Json,
  context: LayoutContext,
  warnings: string[],
): Promise<{ artifacts: Artifact[]; root: string } | undefined> {
  if (context.fetch === undefined) {
    warnings.push(
      `Skipped ${quoted(remote.name)}: aireg fetches its ${remote.type} source only for a marketplace it reads with git.`,
    );
    return undefined;
  }
  let fetched: FetchedPlugin;
  try {
    fetched = await context.fetch(remote);
  } catch (error) {
    const reason = (error as Error).message.replace(/\.$/, "");
    warnings.push(`Skipped ${quoted(remote.name)}: ${reason}.`);
    return undefined;
  }
  const own = await openTree(fetched.root);
  const said: string[] = [];
  const found = await readPlugin(
    own,
    { dir: "", entry, name: remote.name, rootSource: false },
    said,
  );
  // Its paths are in a repository of its own, so each warning names the plugin.
  for (const warning of new Set(said)) warnings.push(`In ${quoted(remote.name)}: ${warning}`);
  if (found === undefined) return undefined;
  const prefix = `${REMOTE}/${remote.name}`;
  return {
    root: fetched.root,
    artifacts: found.map((artifact) => ({
      ...artifact,
      id: artifact.id === ROOT_ID ? prefix : `${prefix}/${artifact.id}`,
      revision: fetched.revision,
      ...(fetched.version === undefined ? {} : { version: fetched.version }),
    })),
  };
}

/** Where the ids of fetched plugins begin, which no folder in a marketplace can be named. */
const REMOTE = "@remote";

const names = (marketplace: Marketplace) =>
  new Set(marketplace.entries.map((entry) => textOf(entry.name)).filter((n) => n !== undefined));

/** Said when both marketplaces are there and disagree, so a plugin only one lists is not lost quietly. */
function disagreement(first: Marketplace, second: Marketplace): string | undefined {
  const [a, b] = [names(first), names(second)];
  const onlyFirst = [...a].filter((name) => !b.has(name)).sort();
  const onlySecond = [...b].filter((name) => !a.has(name)).sort();
  if (onlyFirst.length === 0 && onlySecond.length === 0) return undefined;
  const differ = [...onlyFirst, ...onlySecond].map(quoted);
  return `The two marketplace files list different plugins, so aireg reads ${first.path} alone: ${list(differ)} ${differ.length === 1 ? "is" : "are"} in only one.`;
}

async function marketplaces(tree: Tree): Promise<Marketplace[]> {
  const found: Marketplace[] = [];
  for (const path of MARKETPLACES) {
    const read = await readMarketplace(tree, path);
    if (read !== undefined) found.push(read);
  }
  return found;
}

/** Remote plugins fetched at once. One repository's take turns, since they share its cache. */
const FETCHES_AT_ONCE = 8;

type Fetched = { plugin: Awaited<ReturnType<typeof fetchedPlugin>>; warnings: string[] };

/** A repository however a source writes it: `acme/x`, or its github.com URL. */
const repositoryOf = (remote: RemotePlugin) =>
  remote.location
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");

/** Starts fetching every remote entry, each with its own warnings, to be read in entry order. */
function prefetch(marketplace: Marketplace, context: LayoutContext): Map<Json, Promise<Fetched>> {
  let free = FETCHES_AT_ONCE;
  const waiting: (() => void)[] = [];
  // A finished fetch hands its slot to the next one waiting, so no more than the limit run.
  const slot = (): Promise<void> => {
    if (free === 0) return new Promise((go) => waiting.push(go));
    free -= 1;
    return Promise.resolve();
  };
  const release = () => {
    const next = waiting.shift();
    if (next === undefined) free += 1;
    else next();
  };
  const turns = new Map<string, Promise<unknown>>();
  const started = new Map<Json, Promise<Fetched>>();
  for (const entry of marketplace.entries) {
    const name = textOf(entry.name);
    const at = name === undefined ? undefined : sourceOf(entry, name, marketplace);
    if (at === undefined || !("remote" in at) || context.asked?.(at.remote.name) === false)
      continue;
    const warnings: string[] = [];
    const repository = repositoryOf(at.remote);
    const fetched = (turns.get(repository) ?? Promise.resolve()).then(async () => {
      await slot();
      try {
        return { plugin: await fetchedPlugin(at.remote, entry, context, warnings), warnings };
      } finally {
        release();
      }
    });
    turns.set(
      repository,
      fetched.catch(() => undefined),
    );
    started.set(entry, fetched);
  }
  return started;
}

/** One entry's plugin and its parts, read where its source says, or undefined when skipped. */
async function entryPlugin(
  tree: Tree,
  marketplace: Marketplace,
  { entry, name }: { entry: Json; name: string },
  fetching: ReadonlyMap<Json, Promise<Fetched>>,
  roots: Map<string, string>,
  warnings: string[],
): Promise<Artifact[] | undefined> {
  const at = sourceOf(entry, name, marketplace);
  if ("skip" in at) {
    warnings.push(`Skipped ${quoted(name)}: ${at.skip}.`);
    return undefined;
  }
  if ("remote" in at) {
    const fetched = (await fetching.get(entry)) ?? { plugin: undefined, warnings: [] };
    warnings.push(...fetched.warnings);
    for (const artifact of fetched.plugin?.artifacts ?? []) {
      roots.set(artifact.id, fetched.plugin?.root as string);
    }
    return fetched.plugin?.artifacts;
  }

  if (at.dir !== "" && (await tree.list(at.dir)).length === 0) {
    warnings.push(`Skipped ${quoted(name)}: ${at.dir} is not a folder in the marketplace.`);
    return undefined;
  }
  return readPlugin(tree, { dir: at.dir, entry, name, rootSource: at.dir === "" }, warnings);
}

/**
 * A plugin marketplace, Claude Code's or Codex's, or a lone plugin manifest, which is a
 * marketplace of one. Each plugin installs whole, as a `plugin` artifact.
 */
export const marketplaceLayout: Layout = {
  id: "marketplace",
  looksFor: ["marketplace.json", "plugin.json"],
  async match(tree) {
    if ((await marketplaces(tree)).length > 0) return "yes";
    return (await pluginManifest(tree, "")) === undefined ? "no" : "yes";
  },
  async enumerate(tree, context): Promise<Found> {
    const warnings: string[] = [];
    const [chosen, other] = await marketplaces(tree);
    if (chosen !== undefined && other !== undefined) {
      const said = disagreement(chosen, other);
      if (said !== undefined) warnings.push(said);
    }
    const artifacts: Artifact[] = [];
    if (chosen === undefined) {
      const found = await readPlugin(
        tree,
        { dir: "", name: context.rootName, rootSource: false },
        warnings,
      );
      return { artifacts: found ?? [], warnings };
    }
    const taken = new Set<string>();
    const roots = new Map<string, string>();
    const fetching = prefetch(chosen, context);
    for (const entry of chosen.entries) {
      const name = textOf(entry.name);
      if (name === undefined) {
        warnings.push(`Skipped a plugin in ${chosen.path} that has no name.`);
        continue;
      }
      if (context.asked?.(name) === false) continue;
      const found = await entryPlugin(tree, chosen, { entry, name }, fetching, roots, warnings);
      const [plugin] = found ?? [];
      if (found === undefined || plugin === undefined) continue;
      const pluginName = plugin.envelope.metadata.name;
      if (taken.has(pluginName)) {
        warnings.push(
          `Skipped ${quoted(name)}: another plugin in ${chosen.path} is also named ${quoted(pluginName)}.`,
        );
        continue;
      }
      taken.add(pluginName);
      artifacts.push(...found);
    }
    return { artifacts, warnings, name: chosen.name, ...(roots.size === 0 ? {} : { roots }) };
  },
};
