import { posix } from "node:path";
import { readJson, SpecError } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { isKindSegment, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { isRemote } from "#adapter/filespec/resolve.ts";
import { isSafePath } from "#adapter/paths.ts";
import { quoted, sanitizeName } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { dict, isRecord } from "#core/fields.ts";
import { frontmatterRecord } from "#core/frontmatter.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import { AGENT_CARD_ENTRY } from "#core/product.ts";
import agent from "#schema/kinds/agent.json" with { type: "json" };
import skill from "#schema/kinds/skill.json" with { type: "json" };

import { prepareManifest } from "./schema.ts";

/** Fields the scaffolder understands; validation accepts the full JSON Schema vocabulary. */
export interface SchemaNode {
  [keyword: string]: unknown;
  type?: string | readonly string[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean | SchemaNode;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  enum?: readonly unknown[];
  default?: unknown;
}

interface FileRule {
  path?: string;
  glob?: string;
}

export interface KindManifest extends SchemaNode {
  title: string;
  "x-registry-files": {
    required?: readonly FileRule[];
    optional?: readonly FileRule[];
    one_of?: readonly (readonly FileRule[])[];
  };
}

/** The kinds the file spec defines, so a registry that names none still has them. */
const BUNDLED: Readonly<Record<string, KindManifest>> = dict([
  ["skill", skill as KindManifest],
  ["agent", agent as KindManifest],
]);

type Served = { manifest: KindManifest } | { problem: string };

/**
 * The kinds a registry holds: those its `registry.json` lists with a manifest it
 * serves, else the ones the spec defines.
 */
export async function kindsOf(root: string | undefined): Promise<Record<string, KindManifest>> {
  if (root === undefined) return dict(Object.entries(BUNDLED));
  const listed = await listedKinds(root);
  if (listed.length === 0) return dict(Object.entries(BUNDLED));
  const kinds = dict<KindManifest>();
  for (const { name, served, invalid } of listed) {
    if (invalid === true) continue;
    const manifest =
      (served !== undefined && "manifest" in served ? served.manifest : undefined) ?? BUNDLED[name];
    if (manifest !== undefined) kinds[name] = manifest;
  }
  return kinds;
}

interface Listed {
  name: string;
  url?: string;
  served?: Served;
  /** A name the kind grammar refuses: it would become a command and a folder, so it is neither. */
  invalid?: true;
}

/** Each kind `registry.json` lists, with the manifest it serves when it names one in the root. */
async function listedKinds(root: string): Promise<Listed[]> {
  const registry = await readJson(rootReader(root), REGISTRY_DOCUMENT).catch(() => undefined);
  const listed = isRecord(registry) && Array.isArray(registry.kinds) ? registry.kinds : [];
  const kinds: Listed[] = [];
  for (const item of listed) {
    const { name, manifest_url: url } = (item ?? {}) as { name?: unknown; manifest_url?: unknown };
    if (typeof name !== "string") continue;
    if (!isKindSegment(name)) kinds.push({ name, invalid: true });
    else if (typeof url !== "string" || isRemote(url)) kinds.push({ name });
    else kinds.push({ name, url, served: await served(root, url) });
  }
  return kinds;
}

async function served(root: string, url: string): Promise<Served> {
  if (url.startsWith("/") || url.split(posix.sep).includes("..")) {
    return { problem: "is not a path inside the registry" };
  }
  let raw: unknown;
  try {
    raw = await readJson(rootReader(root), url);
  } catch (error) {
    const unparsed = error instanceof SpecError && error.cause instanceof SyntaxError;
    return { problem: unparsed ? "is not valid JSON" : "could not be read" };
  }
  if (raw === undefined) return { problem: "is missing" };
  if (!isRecord(raw) || !("x-registry-files" in raw)) {
    return { problem: "has no x-registry-files, so it is not a kind manifest" };
  }
  // `aireg <kind> new` writes these paths, so each must stay inside the version folder.
  const unsafe = filePaths(raw["x-registry-files"]).find(
    (path) => typeof path !== "string" || !isSafePath(path),
  );
  if (unsafe !== undefined) {
    const named = quoted(String(unsafe));
    return { problem: `names the file ${named}, which is not a path inside a version` };
  }
  try {
    await prepareManifest(root, raw);
  } catch (error) {
    return { problem: `has an invalid kind schema: ${(error as Error).message}` };
  }
  return { manifest: raw as unknown as KindManifest };
}

function filePaths(files: unknown): unknown[] {
  if (!isRecord(files)) return [];
  const rules = [
    files.required,
    files.optional,
    ...(Array.isArray(files.one_of) ? files.one_of : []),
  ];
  return rules
    .flatMap((set) => (Array.isArray(set) ? set : []))
    .flatMap((rule) => (isRecord(rule) && "path" in rule ? [rule.path] : []));
}

/** Each manifest `registry.json` names in the root that cannot be used, and what becomes of its kind. */
export async function manifestProblems(root: string): Promise<{ path: string; message: string }[]> {
  return (await listedKinds(root)).flatMap(({ name, url, served, invalid }) => {
    if (invalid === true) {
      const message = `lists ${quoted(name)}, which is not a kind name, so it is not used`;
      return [{ path: REGISTRY_DOCUMENT, message }];
    }
    if (url === undefined || served === undefined || !("problem" in served)) return [];
    const instead =
      BUNDLED[name] === undefined
        ? "is left out and its artifacts fail"
        : "is checked against the one aireg bundles";
    return [{ path: url, message: `${served.problem}, so ${quoted(name)} ${instead}` }];
  });
}

/** Where a kind `registry.json` names is served, and why it is left out, when it is. */
export async function leftOutKind(
  root: string,
  name: string,
): Promise<{ path: string; problem: string } | undefined> {
  if (BUNDLED[name] !== undefined) return undefined;
  const found = (await listedKinds(root)).find((kind) => kind.name === name);
  if (found?.url === undefined || found.served === undefined || !("problem" in found.served)) {
    return undefined;
  }
  return { path: found.url, problem: found.served.problem };
}

/** Shared required files plus the selected alternative, or the first alternative by default. */
export function primaryFiles(manifest: KindManifest, choose?: string): string[] {
  const files = manifest["x-registry-files"];
  const required = (files.required ?? []).flatMap((rule) =>
    rule.path === undefined ? [] : [rule.path],
  );
  const sets = (files.one_of ?? []).map((set) =>
    set.flatMap((rule) => (rule.path === undefined ? [] : [rule.path])),
  );
  const selected = choose === undefined ? sets[0] : sets.find((set) => set.includes(choose));
  if (
    choose !== undefined &&
    selected === undefined &&
    !(sets.length === 0 && required.includes(choose))
  ) {
    throw new AiregError(`${quoted(choose)} is not a file alternative for ${manifest.title}.`, {
      code: ErrorCode.Usage,
    });
  }
  return [...new Set([...required, ...(selected ?? [])])];
}

/** Missing required files and conflicting complete file alternatives. */
export function fileProblems(manifest: KindManifest, present: ReadonlySet<string>): string[] {
  const files = manifest["x-registry-files"];
  const missing = (files.required ?? [])
    .flatMap((rule) => (rule.path === undefined ? [] : [rule.path]))
    .filter((path) => !present.has(path))
    .map((path) => `has no ${path}`);
  const sets = files.one_of ?? [];
  if (sets.length > 0) {
    const whole = sets.filter((set) =>
      set.every((rule) => rule.path === undefined || present.has(rule.path)),
    );
    const choices = sets
      .map((set) => set.map((rule) => rule.path ?? rule.glob).join(" + "))
      .join(" or ");
    if (whole.length === 0) missing.push(`has no ${choices}`);
    if (whole.length > 1) missing.push(`must contain exactly one file alternative: ${choices}`);
  }
  return missing;
}

/** The Markdown file whose front matter is the kind's `spec`, when there is one. */
export function specFile(
  manifest: KindManifest,
  files: ReadonlyMap<string, string>,
): string | undefined {
  if (manifest.title === "skill") return files.has(SKILL_ENTRY) ? SKILL_ENTRY : undefined;
  if (manifest.title === "agent") return files.has(AGENT_ENTRY) ? AGENT_ENTRY : undefined;
  return [...primaryFiles(manifest), ...files.keys()].find(
    (path) => path.endsWith(".md") && files.has(path),
  );
}

/**
 * The `spec` a new envelope carries (section 3.4, required): the kind's own
 * document, read from its files, or an empty one for a kind that has none.
 */
export function envelopeSpec(
  kind: string,
  files: ReadonlyMap<string, Uint8Array>,
  manifests: Readonly<Record<string, KindManifest>> = BUNDLED,
  name?: string,
): Record<string, unknown> {
  const manifest = manifests[kind];
  if (manifest === undefined) return {};
  const text = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (/\.(md|json)$/.test(path)) text.set(path, Buffer.from(bytes).toString("utf8"));
  }
  return specOf(manifest, text, name) ?? {};
}

export function specOf(
  manifest: KindManifest,
  files: ReadonlyMap<string, string>,
  name?: string,
): Record<string, unknown> | undefined {
  const markdown = specFile(manifest, files);
  if (markdown !== undefined) return frontmatterRecord(files.get(markdown) ?? "");
  if (manifest.title === "skill") return undefined;
  const json =
    manifest.title === "agent"
      ? files.has(AGENT_CARD_ENTRY)
        ? AGENT_CARD_ENTRY
        : undefined
      : [...files.keys()].find((path) => path.endsWith(".json"));
  if (json === undefined) return undefined;
  let card: unknown;
  try {
    card = JSON.parse(files.get(json) ?? "") as unknown;
  } catch {
    return undefined;
  }
  // The card stays verbatim, with the fields a kind requires lifted beside it (`kinds/agent.json`).
  const lifted: Record<string, unknown> = {};
  if (isRecord(card)) {
    for (const field of ["name", "description"]) {
      const value = card[field];
      if (value !== undefined) lifted[field] = value;
    }
  }
  if (manifest.title === "agent") {
    if (name !== undefined) lifted.name = name;
    else if (typeof lifted.name === "string") lifted.name = sanitizeName(lifted.name);
  }
  return { ...lifted, card };
}
