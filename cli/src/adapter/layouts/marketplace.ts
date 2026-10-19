import { posix } from "node:path";
import type { Artifact } from "../contract.ts";
import { SpecError } from "../filespec/documents.ts";
import { list, quoted } from "../text.ts";
import type { Found, Layout } from "./layout.ts";
import { type Json, pluginManifest, readObject, readPlugin } from "./plugin.ts";
import type { Tree } from "./tree.ts";

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
function sourceOf(entry: Json, pluginRoot: string | undefined): { dir: string } | { skip: string } {
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
  const type = isRecord(source) ? textOf(source.source) : undefined;
  return { skip: `its ${type === undefined ? "" : `${type} `}source is not one aireg reads` };
}

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
    for (const entry of chosen.entries) {
      const name = textOf(entry.name);
      if (name === undefined) {
        warnings.push(`Skipped a plugin in ${chosen.path} that has no name.`);
        continue;
      }
      const at = sourceOf(entry, chosen.pluginRoot);
      if ("skip" in at) {
        warnings.push(`Skipped ${quoted(name)}: ${at.skip}.`);
        continue;
      }
      if (at.dir !== "" && (await tree.list(at.dir)).length === 0) {
        warnings.push(`Skipped ${quoted(name)}: ${at.dir} is not a folder in the marketplace.`);
        continue;
      }
      const found = await readPlugin(
        tree,
        { dir: at.dir, entry, name, rootSource: at.dir === "" },
        warnings,
      );
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
    return { artifacts, warnings, name: chosen.name };
  },
};
