import { posix } from "node:path";
import { readJson, SpecError } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { isRemote } from "#adapter/filespec/resolve.ts";
import { list, quoted } from "#adapter/text.ts";
import { frontmatterRecord } from "#core/catalog/frontmatter.ts";
import { dict, isRecord } from "#core/fields.ts";
import agent from "#schema/kinds/agent.json" with { type: "json" };
import skill from "#schema/kinds/skill.json" with { type: "json" };

/** The part of JSON Schema a kind manifest uses for its `spec`, which is all that is checked here. */
export interface SchemaNode {
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

/** A manifest a registry serves itself, or why it could not be used. */
type Served = { manifest: KindManifest } | { problem: string };

/** Each kind `registry.json` lists, with the manifest it serves when it names one in the root. */
async function listedKinds(
  root: string,
): Promise<{ name: string; url?: string; served?: Served }[]> {
  const registry = await readJson(rootReader(root), REGISTRY_DOCUMENT).catch(() => undefined);
  const listed = isRecord(registry) && Array.isArray(registry.kinds) ? registry.kinds : [];
  const kinds: { name: string; url?: string; served?: Served }[] = [];
  for (const item of listed) {
    const { name, manifest_url: url } = (item ?? {}) as { name?: unknown; manifest_url?: unknown };
    if (typeof name !== "string") continue;
    if (typeof url !== "string" || isRemote(url)) kinds.push({ name });
    else kinds.push({ name, url, served: await served(root, url) });
  }
  return kinds;
}

/**
 * The kinds a registry holds: those its `registry.json` lists with a manifest it
 * serves, else the ones the spec defines.
 */
export async function kindsOf(root: string | undefined): Promise<Record<string, KindManifest>> {
  if (root === undefined) return dict(Object.entries(BUNDLED));
  const listed = await listedKinds(root);
  if (listed.length === 0) return dict(Object.entries(BUNDLED));
  const kinds = dict<KindManifest>();
  for (const { name, served } of listed) {
    const manifest =
      (served !== undefined && "manifest" in served ? served.manifest : undefined) ?? BUNDLED[name];
    if (manifest !== undefined) kinds[name] = manifest;
  }
  return kinds;
}

/** Each manifest `registry.json` names in the root that cannot be used, and what is checked instead. */
export async function manifestProblems(root: string): Promise<{ path: string; message: string }[]> {
  return (await listedKinds(root)).flatMap(({ name, url, served }) => {
    if (url === undefined || served === undefined || !("problem" in served)) return [];
    const instead =
      BUNDLED[name] === undefined ? "not checked" : "checked against the one aireg bundles";
    return [{ path: url, message: `${served.problem}, so ${quoted(name)} is ${instead}` }];
  });
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
  return { manifest: raw as unknown as KindManifest };
}

/** The files a new artifact of this kind is created with: the required ones, else the first set of a choice. */
export function primaryFiles(manifest: KindManifest, choose?: string): string[] {
  const files = manifest["x-registry-files"];
  const required = (files.required ?? []).flatMap((rule) =>
    rule.path === undefined ? [] : [rule.path],
  );
  if (required.length > 0) return required;
  const sets = (files.one_of ?? []).map((set) =>
    set.flatMap((rule) => (rule.path === undefined ? [] : [rule.path])),
  );
  return sets.find((set) => choose !== undefined && set.includes(choose)) ?? sets[0] ?? [];
}

/** Which required files, or file sets, a version is missing. */
export function missingFiles(manifest: KindManifest, present: ReadonlySet<string>): string[] {
  const files = manifest["x-registry-files"];
  const missing = (files.required ?? [])
    .flatMap((rule) => (rule.path === undefined ? [] : [rule.path]))
    .filter((path) => !present.has(path));
  const sets = files.one_of ?? [];
  if (sets.length > 0) {
    const whole = sets.some((set) =>
      set.every((rule) => rule.path === undefined || present.has(rule.path)),
    );
    if (!whole) {
      missing.push(sets.map((set) => set.map((rule) => rule.path).join(" + ")).join(" or "));
    }
  }
  return missing;
}

/** The Markdown file whose front matter is the kind's `spec`, when there is one. */
export function specFile(
  manifest: KindManifest,
  files: ReadonlyMap<string, string>,
): string | undefined {
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
): Record<string, unknown> {
  const manifest = manifests[kind];
  if (manifest === undefined) return {};
  const text = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (/\.(md|json)$/.test(path)) text.set(path, Buffer.from(bytes).toString("utf8"));
  }
  return specOf(manifest, text) ?? {};
}

export function specOf(
  manifest: KindManifest,
  files: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const markdown = specFile(manifest, files);
  if (markdown !== undefined) return frontmatterRecord(files.get(markdown) ?? "");
  const json = [...files.keys()].find((path) => path.endsWith(".json"));
  if (json === undefined) return undefined;
  let card: unknown;
  try {
    card = JSON.parse(files.get(json) ?? "") as unknown;
  } catch {
    return undefined;
  }
  // The card stays verbatim; the fields a kind requires are lifted beside it, as `kinds/agent.json` describes.
  const lifted: Record<string, unknown> = {};
  if (isRecord(card)) {
    for (const field of ["name", "description", "runtime"]) {
      const value = card[field];
      if (value !== undefined) lifted[field] = value;
    }
  }
  return { ...lifted, card };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

/** Problems with one value against a manifest's schema, each naming the field. */
export function check(schema: SchemaNode, value: unknown, at = ""): string[] {
  const where = at === "" ? "the front matter" : `\`${at}\``;
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const actual = typeOf(value);
  const numeric = actual === "integer" && types.includes("number");
  if (types.length > 0 && !types.includes(actual) && !numeric) {
    return [`${where} must be ${types.join(" or ")}`];
  }
  const problems: string[] = [];
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${where} must be ${list(schema.enum.map(String), "or")}`);
  }
  if (typeof value === "string") problems.push(...stringProblems(schema, value, where));
  if (actual === "object") {
    problems.push(...objectProblems(schema, value as Record<string, unknown>, at));
  }
  return problems;
}

function stringProblems(schema: SchemaNode, value: string, where: string): string[] {
  const problems: string[] = [];
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    problems.push(
      value === ""
        ? `${where} is empty`
        : `${where} is shorter than ${schema.minLength} characters`,
    );
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    problems.push(`${where} is longer than ${schema.maxLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${where} ${quoted(value)} does not match ${schema.pattern}`);
  }
  return problems;
}

function objectProblems(schema: SchemaNode, record: Record<string, unknown>, at: string): string[] {
  const field = (key: string) => (at === "" ? key : `${at}.${key}`);
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) problems.push(`\`${field(key)}\` is required`);
  }
  for (const [key, item] of Object.entries(record)) {
    const child = schema.properties?.[key];
    const extra = schema.additionalProperties;
    if (child !== undefined) problems.push(...check(child, item, field(key)));
    else if (extra === false) problems.push(`\`${field(key)}\` is not a field this kind takes`);
    else if (typeof extra === "object") problems.push(...check(extra, item, field(key)));
  }
  return problems;
}
