import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { canonicalConfig, type SourceConfig } from "#core/adapter/identity.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isMissing } from "#core/fs/path.ts";
import { parseEngine } from "#core/semver.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { type Roots, type Scope, scopeName } from "#core/store/paths.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import {
  dict,
  type Fields,
  isRecord,
  namesOf,
  RESERVED_KEYS,
  textMapOf,
  unknownKeysProblem,
  withoutUndefined,
} from "./fields.ts";
import { NAME } from "./product.ts";
import {
  formatAddress,
  formatRef,
  parseRef,
  type Ref,
  relativeTo,
  withExclusions,
  withLocalName,
} from "./ref.ts";
import { parseYaml } from "./yaml.ts";

/** One address, and whatever the adapter reading it needs to know. */
export interface RegistrySource {
  location: string;
  /** Omitted means "ask which adapter recognizes this". */
  adapter: string | undefined;
  config: SourceConfig;
}

export interface Manifest {
  /** Carried so an editor keeps its schema hint when a command rewrites the file. */
  schema: string | undefined;
  name: string | undefined;
  description: string | undefined;
  /** Oldest aireg CLI that can read this file. Plain SemVer, meaning >=. */
  engine: string | undefined;
  /** `harnesses:`, the harnesses to project into. Empty means every harness detected. */
  targets: string[];
  /** `registries:`, keyed by the name a reference uses. */
  registries: Record<string, RegistrySource>;
  artifacts: Ref[];
}

/** The published schema is held to this list. */
export const MANIFEST_KEYS = [
  "$schema",
  "name",
  "description",
  "engines",
  "harnesses",
  "registries",
  "artifacts",
] as const;

/** Every transport's keys; which are legal together is checked below. */
export const REGISTRY_KEYS = ["source", "adapter", "ref", "path", "config"] as const;

export class ManifestError extends AiregError {
  constructor(message: string, hint?: string) {
    super(message, { code: ErrorCode.Invalid, hint });
    this.name = "ManifestError";
  }
}

/**
 * One failure for a registry a scope does not declare, wherever it is looked
 * up; `hint` replaces the default when the caller knows a better next step.
 */
export function unknownRegistry(
  alias: string,
  scope: Scope,
  known: Iterable<string>,
  hint?: string,
  /** Where it was looked for, when that was more than the scope. */
  searched = scopeName(scope),
): AiregError {
  const names = [...known].sort();
  const declare = `\`aireg registry add <address>${scope === "user" ? " -g" : ""}\``;
  return new AiregError(`No registry named ${quoted(alias)} in ${searched}.`, {
    code: ErrorCode.NotFound,
    hint:
      hint ??
      (names.length > 0
        ? `Use ${list(names, "or")}, or declare another with ${declare}.`
        : `Declare one first with ${declare}, such as github.com/owner/repo.`),
  });
}

export function emptyManifest(): Manifest {
  return {
    schema: undefined,
    name: undefined,
    description: undefined,
    engine: undefined,
    targets: [],
    registries: dict(),
    artifacts: [],
  };
}

function parseEnginesField(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ManifestError("`engines:` must be a mapping.");
  const record = raw;
  onlyKnown(record, [NAME], "`engines:`");
  const value = record[NAME];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManifestError(`\`engines.${NAME}\` must be a version.`);
  const version = parseEngine(value);
  if (version === undefined) {
    throw new ManifestError(`\`engines.${NAME}\` must be a plain version such as 0.3.0.`);
  }
  return version;
}

function optionalString(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManifestError(`\`${key}:\` must be text.`);
  return value;
}

function sourceConfig(raw: unknown, alias: string): SourceConfig {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new ManifestError(`\`config:\` of registry ${quoted(alias)} must be a mapping.`);
  }
  const identity = textMapOf(raw);
  if (identity === undefined) {
    throw new ManifestError(
      `\`config:\` of registry ${quoted(alias)} must have non-empty keys and values.`,
    );
  }
  return canonicalConfig(identity);
}

/** A key nobody reads is a typo, and ignoring it hides what the file does. */
function onlyKnown(record: Fields, known: readonly string[], where: string): void {
  const problem = unknownKeysProblem(record, known, where);
  if (problem !== undefined) throw new ManifestError(problem);
}

/** Far past any real address, and short enough that no parse of one can stall a run. */
const MAX_LOCATION = 2048;

function address(alias: string, location: string): string {
  if (location.length > MAX_LOCATION) {
    throw new ManifestError(`Registry ${quoted(alias)} has an address too long to be one.`);
  }
  return location;
}

function parseSource(alias: string, raw: unknown): RegistrySource {
  if (typeof raw === "string") {
    if (raw.trim() === "") throw new ManifestError(`Registry ${quoted(alias)} has no address.`);
    return { location: address(alias, raw), adapter: undefined, config: {} };
  }
  if (!isRecord(raw)) {
    throw new ManifestError(`Registry ${quoted(alias)} must be an address or a mapping.`);
  }
  const entry = raw;
  onlyKnown(entry, REGISTRY_KEYS, `Registry ${quoted(alias)}`);

  const location = optionalString(entry, "source");
  if (location === undefined || location.trim() === "") {
    throw new ManifestError(`Registry ${quoted(alias)} has no \`source:\`.`);
  }

  // `ref` is first class because nearly every versioned source has one, but it
  // is the adapter that decides what it means.
  const ref = optionalString(entry, "ref");
  const path = optionalString(entry, "path");
  const config = sourceConfig(entry.config, alias);
  return {
    location: address(alias, location),
    adapter: optionalString(entry, "adapter"),
    config: canonicalConfig({
      ...config,
      ...(ref === undefined ? {} : { ref }),
      ...(path === undefined ? {} : { path }),
    }),
  };
}

// Names are checked against the harness table, which the parser does not load.
function parseSelection(raw: unknown, key: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`\`${key}:\` must be a list of harness names.`);
  return raw.map((entry) => {
    if (typeof entry !== "string") throw new ManifestError(`\`${key}:\` must list harness names.`);
    return entry;
  });
}

function artifactRef(raw: unknown): Ref {
  if (typeof raw === "string") return parseRef(raw);
  if (!isRecord(raw)) {
    throw new ManifestError("`artifacts:` entries must be references or `{ ref, ... }` mappings.");
  }
  const entry = raw;
  onlyKnown(entry, ["ref", "as", "exclude", "harnesses", "copy"], "An `artifacts:` entry");
  const text = optionalString(entry, "ref");
  if (text === undefined) throw new ManifestError("An `artifacts:` entry has no `ref`.");
  const localName = optionalString(entry, "as");
  const exclude = stringList(entry.exclude, text, "exclude");
  const targets = stringList(entry.harnesses, text, "harnesses");
  if (entry.copy !== undefined && typeof entry.copy !== "boolean") {
    throw new ManifestError(`\`copy\` of artifact ${quoted(text)} must be true or false.`);
  }
  if (localName !== undefined && exclude !== undefined) {
    throw new ManifestError(`Artifact ${quoted(text)} cannot have both \`as\` and \`exclude\`.`);
  }
  let ref = parseRef(text);
  if (localName !== undefined) ref = withLocalName(ref, localName);
  if (exclude !== undefined) ref = withExclusions(ref, exclude);
  if (entry.copy === true) ref = { ...ref, copy: true };
  return targets === undefined ? ref : { ...ref, targets };
}

function stringList(raw: unknown, ref: string, key: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const names = namesOf(raw);
  if (names === undefined) {
    throw new ManifestError(`\`${key}:\` of artifact ${quoted(ref)} must be a list of names.`);
  }
  return names;
}

function parseRegistries(root: Record<string, unknown>): Record<string, RegistrySource> {
  const registries = root.registries;
  if (registries === undefined || registries === null) return {};
  if (typeof registries !== "object" || Array.isArray(registries)) {
    throw new ManifestError("`registries:` must map names to addresses.");
  }
  const out = dict<RegistrySource>();
  for (const [alias, raw] of Object.entries(registries as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(alias)) {
      throw new ManifestError(`${quoted(alias)} cannot name a registry.`);
    }
    out[alias] = parseSource(alias, raw);
  }
  return out;
}

export function parseManifest(text: string, filename = "manifest.yml"): Manifest {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (cause) {
    const first = (cause as Error).message.split("\n")[0]?.replace(/:$/, "");
    throw new ManifestError(`${filename} is not valid YAML: ${first}.`);
  }

  if (doc === null || doc === undefined) return emptyManifest();
  if (!isRecord(doc)) throw new ManifestError(`${filename} must be a mapping at the top level.`);
  try {
    return parseFields(doc);
  } catch (error) {
    // Each check names a field; only here is the file it came from known.
    if (!(error instanceof ManifestError)) throw error;
    throw new ManifestError(`${filename}: ${error.message}`, error.hint);
  }
}

function parseFields(root: Record<string, unknown>): Manifest {
  onlyKnown(root, MANIFEST_KEYS, "The manifest");
  const registries = parseRegistries(root);
  const targets = parseSelection(root.harnesses, "harnesses");

  const artifacts: Ref[] = [];
  if (root.artifacts !== undefined && root.artifacts !== null) {
    if (!Array.isArray(root.artifacts)) {
      throw new ManifestError("`artifacts:` must be a list of references.");
    }
    for (const entry of root.artifacts) {
      artifacts.push(artifactRef(entry));
    }
  }

  const seen = new Set<string>();
  for (const ref of artifacts) {
    if (registries[ref.registry] === undefined) {
      throw new ManifestError(
        `Artifact ${quoted(formatRef(ref))} names registry ${quoted(ref.registry)}, which is not declared under \`registries:\`.`,
        `Declare it with \`aireg registry add <address> --as ${ref.registry}\`.`,
      );
    }
    // Keyed by address, so declaring one artifact at two versions is caught
    // here rather than becoming two entries racing for one install name.
    const address = formatAddress(ref);
    if (seen.has(address)) {
      throw new ManifestError(
        `Artifact ${quoted(address)} is listed more than once, but an artifact installs at one version.`,
      );
    }
    seen.add(address);
  }

  return {
    schema: optionalString(root, "$schema"),
    name: optionalString(root, "name"),
    description: optionalString(root, "description"),
    engine: parseEnginesField(root.engines),
    targets,
    registries,
    artifacts,
  };
}

/** Block style only, so diffs stay line-oriented. */
const FORMAT = {
  indent: 2,
  defaultStringType: "PLAIN",
  lineWidth: 0,
  flowCollectionPadding: false,
} as const;

/** The manifest as plain data, keyed in the order a new file is written in. */
function manifestData(manifest: Manifest): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (manifest.schema !== undefined) doc.$schema = manifest.schema;
  if (manifest.name !== undefined) doc.name = manifest.name;
  if (manifest.description !== undefined) doc.description = manifest.description;
  if (manifest.engine !== undefined) doc.engines = { [NAME]: manifest.engine };
  if (manifest.targets.length > 0) doc.harnesses = manifest.targets;

  const registries: Record<string, unknown> = {};
  for (const alias of Object.keys(manifest.registries).sort()) {
    const source = manifest.registries[alias] as RegistrySource;
    const { ref, path, ...rest } = source.config;
    const written = withoutUndefined({
      source: source.location,
      adapter: source.adapter,
      ref,
      path,
      config: Object.keys(rest).length === 0 ? undefined : rest,
    });
    registries[alias] = Object.keys(written).length === 1 ? source.location : written;
  }
  doc.registries = registries;
  doc.artifacts = manifest.artifacts.map((ref) => {
    const written = withoutUndefined({
      ref: formatRef(ref),
      as: ref.localName,
      exclude: ref.exclude,
      harnesses: ref.targets,
      copy: ref.copy === true ? true : undefined,
    });
    return Object.keys(written).length === 1 ? formatRef(ref) : written;
  });
  return doc;
}

export function formatManifest(manifest: Manifest): string {
  return stringify(manifestData(manifest), FORMAT);
}

const keyOf = (key: unknown): string => String(isScalar(key) ? key.value : key);

/** Changes only what differs, so a node keeps its comments. */
function merged(doc: Document, node: unknown, value: unknown): unknown {
  if (isNode(node) && isDeepStrictEqual(node.toJS(doc), value)) return node;
  if (isMap(node) && isRecord(value)) {
    return mergedMap(doc, node, value as Record<string, unknown>);
  }
  if (isSeq(node) && Array.isArray(value)) return mergedSeq(doc, node, value);
  if (isScalar(node) && (typeof value !== "object" || value === null)) {
    node.value = value;
    return node;
  }
  const created = doc.createNode(value);
  if (isNode(node)) {
    created.commentBefore = node.commentBefore ?? null;
    created.comment = node.comment ?? null;
  }
  return created;
}

function mergedMap(doc: Document, node: YAMLMap, value: Record<string, unknown>): YAMLMap {
  const keys = Object.keys(value);
  // An empty `{}` that gains entries becomes a block; one written inline with entries stays inline.
  if (node.items.length === 0 && keys.length > 0) node.flow = false;
  const kept: typeof node.items = [];
  let carried: string | null = null;
  for (const pair of node.items) {
    if (!keys.includes(keyOf(pair.key))) {
      carried = joined(carried, leading(pair.key));
      continue;
    }
    if (carried !== null && isNode(pair.key)) {
      pair.key.commentBefore = joined(carried, pair.key.commentBefore);
      carried = null;
    }
    kept.push(pair);
  }
  node.items = kept;
  for (const [index, key] of keys.entries()) {
    const pair = node.items.find((item) => keyOf(item.key) === key);
    if (pair !== undefined) {
      pair.value = merged(doc, pair.value, value[key]);
      continue;
    }
    const later = keys.slice(index + 1);
    const at = node.items.findIndex((item) => later.includes(keyOf(item.key)));
    node.items.splice(at === -1 ? node.items.length : at, 0, doc.createPair(key, value[key]));
  }
  return node;
}

/** Entries match by value; one edited in place keeps its slot's comment. */
function mergedSeq(doc: Document, node: YAMLSeq, value: readonly unknown[]): YAMLSeq {
  const before = node.items;
  const taken = new Set<number>();
  const same = value.map((item) => {
    const at = before.findIndex(
      (existing, index) =>
        !taken.has(index) && isNode(existing) && isDeepStrictEqual(existing.toJS(doc), item),
    );
    if (at !== -1) taken.add(at);
    return at;
  });
  if (before.length === 0 && value.length > 0) node.flow = false;
  node.items = value.map((item, index) => {
    const at = same[index] ?? -1;
    if (at !== -1) return before[at];
    if (index < before.length && !taken.has(index)) {
      taken.add(index);
      return merged(doc, before[index], item);
    }
    return doc.createNode(item);
  });
  return node;
}

// A comment paragraph belongs to the key right below it, and the parser hands every
// paragraph between two top-level keys to the first; these split them back apart.
const paragraphs = (comment: string | null | undefined): string[] =>
  comment === null || comment === undefined || comment === "" ? [] : comment.split("\n\n");

function joined(...comments: (string | null | undefined)[]): string | null {
  const all = comments.flatMap(paragraphs);
  return all.length === 0 ? null : all.join("\n\n");
}

/** What sits above a deleted key that is not about the key: a file's heading, say. */
function leading(key: unknown): string | null {
  return isNode(key) ? joined(...paragraphs(key.commentBefore).slice(0, -1)) : null;
}

/** The paragraphs trailing a section that a blank line set apart, moved to the key below. */
function separateSections(doc: Document): void {
  if (!isMap(doc.contents)) return;
  const pairs = doc.contents.items;
  for (const [index, pair] of pairs.entries()) {
    const next = pairs[index + 1];
    if (!isNode(pair.value) || !isNode(next?.key)) continue;
    const [own, ...rest] = paragraphs(pair.value.comment);
    if (rest.length === 0) continue;
    pair.value.comment = own ?? null;
    next.key.commentBefore = joined(...rest, next.key.commentBefore);
    next.key.spaceBefore = true;
  }
}

/** Edited in place, so a person's comments and blank lines survive. */
function editManifest(text: string, manifest: Manifest): string {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) return formatManifest(manifest);
  separateSections(doc);
  doc.contents = merged(doc, doc.contents, manifestData(manifest)) as Document["contents"];
  const first = isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  if (isNode(first)) first.spaceBefore = false;
  return doc.toString(FORMAT);
}

export async function readManifest(path: string): Promise<Manifest> {
  try {
    return parseManifest(await readFile(path, "utf8"), path);
  } catch (cause) {
    if (isMissing(cause)) return emptyManifest();
    throw cause;
  }
}

/**
 * Atomic, because commands read the manifest before taking the scope's lease. Takes the
 * scope's roots so a committed `.registry` link cannot redirect the write.
 */
export async function writeManifest(roots: Roots, manifest: Manifest): Promise<string> {
  const path = roots.manifest;
  await guardManagedPath(path, roots);
  const before = await readFile(path, "utf8").catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw cause;
  });
  const text = before === undefined ? formatManifest(manifest) : editManifest(before, manifest);
  // Read back first: a manifest no command could read must never reach the disk.
  parseManifest(text, path);
  await writeAtomic(path, text);
  return text;
}

/** The artifact a lock row installed, as far as a manifest pin can name it. */
export interface Pinnable {
  registry: string;
  name: string;
  kind: string;
  namespace: string | undefined;
}

/**
 * The version the manifest holds an installed artifact at, matched by address:
 * a namespace install names the row `platform/lint`, the pin says `lint@1.0.0`.
 */
export function pinOf(manifest: Manifest, row: Pinnable): string | undefined {
  for (const ref of manifest.artifacts) {
    if (ref.version === undefined || ref.registry !== row.registry) continue;
    if (ref.name !== row.name || (ref.kind !== undefined && ref.kind !== row.kind)) continue;
    if (ref.namespace !== undefined && ref.namespace !== row.namespace) continue;
    return ref.version;
  }
  return undefined;
}

/** Whether a manifest ref reaches one installed row: by address, never by display name. */
export function reaches(ref: Ref, row: Pinnable): boolean {
  if (row.registry !== ref.registry) return false;
  if (ref.namespace !== undefined && row.namespace !== sanitizeName(ref.namespace)) return false;
  if (ref.kind !== undefined && row.kind !== ref.kind) return false;
  return ref.name === undefined || sanitizeName(row.name) === sanitizeName(ref.name);
}

/** One artifact named on its own adds nothing when a whole namespace or registry entry already takes it. */
export function coveredByWhole(ref: Ref, artifacts: readonly Ref[]): boolean {
  if (ref.name === undefined || ref.kind === undefined) return false;
  if (ref.version !== undefined || ref.localName !== undefined) return false;
  if (ref.targets !== undefined || ref.copy === true) return false;
  return artifacts.some(
    (whole) =>
      whole.name === undefined &&
      whole.registry === ref.registry &&
      (whole.namespace === undefined || whole.namespace === ref.namespace) &&
      whole.targets === undefined &&
      whole.copy !== true &&
      !(whole.exclude ?? []).includes(
        relativeTo(whole, {
          namespace: ref.namespace,
          kind: ref.kind as string,
          name: sanitizeName(ref.name as string),
        }),
      ),
  );
}

/** The manifest entries that ask for this row, leaving out any that exclude it. */
export function askingFor(manifest: Manifest, row: Pinnable): Ref[] {
  return manifest.artifacts.filter(
    (ref) =>
      reaches(ref, row) &&
      !(ref.exclude ?? []).includes(
        relativeTo(ref, { namespace: row.namespace, kind: row.kind, name: sanitizeName(row.name) }),
      ),
  );
}

/** Whether the manifest asks for this row itself, rather than for something that needs it. */
export function asksFor(manifest: Manifest, row: Pinnable): boolean {
  return askingFor(manifest, row).length > 0;
}
