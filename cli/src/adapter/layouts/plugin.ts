import { posix } from "node:path";
import type { Artifact } from "../contract.ts";
import { SpecError } from "../filespec/documents.ts";
import { isArtifactName } from "../filespec/names.ts";
import { quoted } from "../text.ts";
import { contentArtifact } from "./envelope.ts";
import { artifactOf, ROOT_ID, SKILL_FILE, skipped } from "./folder.ts";
import type { Tree } from "./tree.ts";

export type Json = Record<string, unknown>;

/** Where a plugin keeps its own manifest, in the order aireg reads them. */
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"];

/** A root `plugin.json` is an Agent Plugins manifest only under this schema. */
const AGENT_PLUGINS_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/[^/]+\/plugin\.schema\.json$/;

/** Manifests are a few kilobytes; anything larger is not one. */
const MAX_MANIFEST = 1024 * 1024;

/** What an entry may add to a plugin's own manifest, as Claude Code's strict mode names them. */
const COMPONENTS = ["commands", "agents", "skills", "hooks", "outputStyles", "themes"];

/** Marketplace bookkeeping, which is not part of the plugin it lists. */
const ENTRY_ONLY = new Set([
  "source",
  "strict",
  "category",
  "tags",
  "relevance",
  "headers",
  "headersHelper",
  "policy",
]);

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A JSON object at `path`, or undefined when there is no file; a file that is no object throws. */
export async function readObject(tree: Tree, path: string): Promise<Json | undefined> {
  if (!(await tree.isFile(path))) return undefined;
  const bytes = await tree.read(path);
  if (bytes === undefined) return undefined;
  if (bytes.byteLength > MAX_MANIFEST) {
    throw new SpecError(`${path} is larger than a manifest can be.`, { path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new SpecError(`${path} is not valid JSON.`, { path, cause });
  }
  if (!isRecord(parsed)) throw new SpecError(`${path} must be a JSON object.`, { path });
  return parsed;
}

const under = (dir: string, path: string) => (dir === "" ? path : `${dir}/${path}`);

/** The manifest a plugin folder holds, by precedence, and where it was found. */
export async function pluginManifest(
  tree: Tree,
  dir: string,
): Promise<{ path: string; manifest: Json } | undefined> {
  for (const name of PLUGIN_MANIFESTS) {
    const path = under(dir, name);
    if (name !== "plugin.json") {
      const manifest = await readObject(tree, path);
      if (manifest !== undefined) return { path, manifest };
      continue;
    }
    // Any project may have a plugin.json; only one under the Agent Plugins schema is a plugin's.
    const manifest = await readObject(tree, path).catch(() => undefined);
    if (manifest !== undefined && AGENT_PLUGINS_SCHEMA.test(String(manifest.$schema))) {
      return { path, manifest };
    }
  }
  return undefined;
}

function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The manifest a target loads: the entry alone when the plugin has none, else the plugin's own
 * with the entry's components appended, which `strict: false` refuses.
 */
function effectiveManifest(own: Json | undefined, entry: Json | undefined): Json | "conflict" {
  const listed = Object.fromEntries(
    Object.entries(entry ?? {}).filter(([key]) => !ENTRY_ONLY.has(key)),
  );
  if (own === undefined) return listed;
  const adds = COMPONENTS.filter((key) => entry?.[key] !== undefined);
  if (adds.length === 0) return own;
  if (entry?.strict === false) return "conflict";
  const merged: Json = { ...own };
  for (const key of adds) {
    if (key === "hooks" && isRecord(own.hooks) && isRecord(entry?.hooks)) {
      merged.hooks = { ...own.hooks, ...entry.hooks };
    } else if (key === "commands" && isRecord(own.commands) && isRecord(entry?.commands)) {
      merged.commands = { ...own.commands, ...entry.commands };
    } else {
      merged[key] = [...listOf(own[key]), ...listOf(entry?.[key])];
    }
  }
  return merged;
}

/** A manifest path, `./x` relative to the plugin, as a path in the tree; undefined if it leaves. */
function inside(dir: string, path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  if (path === "." || path === "./") return dir;
  if (!path.startsWith("./") || path.includes("\\")) return undefined;
  const rest = posix.normalize(path.slice(2)).replace(/\/+$/, "");
  if (rest === "." || rest === "") return dir;
  if (rest.startsWith("../") || rest === "..") return undefined;
  return under(dir, rest);
}

/** Skill folders under each place a manifest names: one holding SKILL.md, or a folder of them. */
async function skillDirs(tree: Tree, places: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const place of places) {
    if (await tree.isFile(under(place, SKILL_FILE))) {
      found.add(place);
      continue;
    }
    for (const entry of await tree.list(place)) {
      if (entry.type === "folder" && (await tree.isFile(`${entry.path}/${SKILL_FILE}`))) {
        found.add(entry.path);
      }
    }
  }
  return [...found].sort();
}

/** `*.md` files: those a manifest names, or each one directly in the default folder. */
async function markdownFiles(tree: Tree, dir: string, named: unknown, folder: string) {
  const places =
    named === undefined ? [under(dir, folder)] : listOf(named).map((p) => inside(dir, p));
  const files: string[] = [];
  for (const place of places) {
    if (place === undefined) continue;
    if (place.endsWith(".md") && (await tree.isFile(place))) {
      files.push(place);
      continue;
    }
    for (const entry of await tree.list(place)) {
      if (entry.type === "file" && entry.name.endsWith(".md")) files.push(entry.path);
    }
  }
  return [...new Set(files)].sort();
}

/** A command as a person runs it, `/plugin:name`, and the file it is written in. */
interface Command {
  name: string;
  path: string;
}

async function commandsOf(tree: Tree, dir: string, manifest: Json): Promise<Command[]> {
  const declared = manifest.commands;
  if (isRecord(declared)) {
    const commands: Command[] = [];
    for (const [name, value] of Object.entries(declared)) {
      const path = isRecord(value) ? inside(dir, value.source) : undefined;
      if (path !== undefined && (await tree.isFile(path))) commands.push({ name, path });
    }
    return commands;
  }
  return (await markdownFiles(tree, dir, declared, "commands")).map((path) => ({
    name: posix.basename(path, ".md"),
    path,
  }));
}

/** What a plugin listing names it, how it was found, and where it lives. */
export interface PluginInput {
  /** The plugin's folder in the tree, `""` for the root. */
  dir: string;
  /** Its marketplace entry, when a marketplace lists it. */
  entry?: Json | undefined;
  /** Its entry's name, which it installs under; alone, the name to use when its manifest has none. */
  name: string;
  /** Listed by a marketplace whose source is its own root, so only the skills it names count. */
  rootSource: boolean;
}

/** Files of a plugin whose folder is the whole source: only what it names, never its neighbors. */
const ROOT_FILES = [
  "hooks",
  "bin",
  "monitors",
  ".mcp.json",
  ".lsp.json",
  ".claude-plugin/plugin.json",
];

async function filesOf(tree: Tree, input: PluginInput, named: readonly string[]) {
  const places = input.rootSource ? [...named, ...ROOT_FILES] : [input.dir];
  const prefix = input.dir === "" ? "" : `${input.dir}/`;
  const files = new Map<string, { path: string; locator: string; executable: boolean }>();
  const warnings: string[] = [];
  for (const place of places) {
    if (place.endsWith(".md") || place.endsWith(".json")) {
      if (await tree.isFile(place)) {
        files.set(place, { path: place.slice(prefix.length), locator: place, executable: false });
      }
      continue;
    }
    const walked = await tree.walk(place);
    for (const skip of walked.skipped) warnings.push(skipped(skip));
    for (const file of walked.files) {
      files.set(file.path, {
        path: file.path.slice(prefix.length),
        locator: file.path,
        executable: file.executable,
      });
    }
  }
  return { files: [...files.values()], warnings };
}

/** Listed, a plugin installs under its entry's name, as Claude Code does; its own still namespaces. */
function namesOf(manifest: Json, input: PluginInput): { name: string; manifestName?: string } {
  const manifestName = textOf(manifest.name);
  const name = input.entry === undefined ? (manifestName ?? input.name) : input.name;
  return manifestName === undefined ? { name } : { name, manifestName };
}

/**
 * One plugin, whole, as a `plugin` artifact, followed by its skills and agents on their own, so
 * a target without plugins gets its parts and `-s` can take one. Undefined when it is skipped.
 */
export async function readPlugin(
  tree: Tree,
  input: PluginInput,
  warnings: string[],
): Promise<Artifact[] | undefined> {
  const own = await pluginManifest(tree, input.dir);
  const manifest = effectiveManifest(own?.manifest, input.entry);
  if (manifest === "conflict") {
    warnings.push(
      `Skipped ${quoted(input.name)}: its entry is \`strict: false\`, but both it and ${own?.path} name components.`,
    );
    return undefined;
  }
  const { name, manifestName } = namesOf(manifest, input);
  if (!isArtifactName(name)) {
    warnings.push(
      `Skipped ${quoted(name)}: it is not a name aireg installs, which takes lowercase letters, digits and hyphens.`,
    );
    return undefined;
  }
  const dir = input.dir;
  const entrySkills = input.rootSource ? input.entry?.skills : undefined;
  const skillPlaces = (
    entrySkills !== undefined ? listOf(entrySkills) : ["./skills", ...listOf(manifest.skills)]
  )
    .map((path) => inside(dir, path))
    .filter((path): path is string => path !== undefined);
  let skills = await skillDirs(tree, skillPlaces);
  const lone = entrySkills === undefined && manifest.skills === undefined;
  if (skills.length === 0 && lone && (await tree.isFile(under(dir, SKILL_FILE)))) {
    skills = [dir === "" ? ROOT_ID : dir];
  }
  const agents = await markdownFiles(tree, dir, manifest.agents, "agents");
  const commands = await commandsOf(tree, dir, manifest);
  const { files, warnings: walked } = await filesOf(tree, input, [
    ...skills.map((skill) => (skill === ROOT_ID ? "" : skill)),
    ...agents,
    ...commands.map((command) => command.path),
  ]);
  warnings.push(...walked);
  if (files.length === 0) {
    warnings.push(`Skipped ${quoted(name)}: its folder holds no files.`);
    return undefined;
  }

  const prefix = dir === "" ? "" : `${dir}/`;
  const description = textOf(manifest.description);
  const plugin = await contentArtifact(tree, {
    id: dir === "" ? ROOT_ID : dir,
    kind: "plugin",
    name,
    description,
    files,
    spec: {
      name,
      ...(description === undefined ? {} : { description }),
      // As text, since a manifest may hold numbers an envelope cannot.
      manifest: JSON.stringify({ ...manifest, name: manifestName ?? name }),
      commands: commands.map((command) => ({
        name: command.name,
        path: command.path.slice(prefix.length),
      })),
    },
  });

  const members: Artifact[] = [];
  for (const at of skills) {
    const member = at === ROOT_ID || at === dir ? name : posix.basename(at);
    if (!isArtifactName(member)) continue;
    members.push(
      await artifactOf(tree, { kind: "skill", at, name: member, namespace: name }, warnings),
    );
  }
  // Only an agent directly in its folder: a nested one's name is the folder path, which aireg cannot install under.
  for (const at of agents) {
    const member = posix.basename(at, ".md");
    if (!isArtifactName(member) || posix.dirname(at) !== under(dir, "agents")) continue;
    members.push(
      await artifactOf(tree, { kind: "agent", at, name: member, namespace: name }, warnings),
    );
  }
  return [plugin, ...members];
}
