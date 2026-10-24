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
import { isNamespace } from "#adapter/filespec/names.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { isLayoutId, LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import { formatVersion, parseVersion } from "#adapter/semver.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { canonicalConfig, type SourceConfig } from "#core/adapter/identity.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isMissing } from "#core/fs/path.ts";
import { parseEngine, unmetEngine } from "#core/semver.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { type Roots, type Scope, scopeName } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import { AiregError, ErrorCode } from "./errors.ts";
import {
  type ExportFile,
  exportExclude,
  exportIgnore,
  exportInclude,
  exportKind,
  isGlob,
  PATH_HINT,
  pathProblem,
} from "./export-fields.ts";
import {
  dict,
  type Fields,
  isRecord,
  namesOf,
  RESERVED_KEYS,
  textMapOf,
  textOf,
  unknownKeysProblem,
  withoutUndefined,
} from "./fields.ts";
import { ManifestError } from "./manifest-error.ts";
import { NAME } from "./product.ts";
import {
  formatAddress,
  formatRef,
  parseRef,
  type Ref,
  RefParseError,
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
  /** `exports:`, what this project makes for others to install. */
  exports: Export[];
  /** `publish:`, where exports go. */
  publish: PublishTarget | undefined;
}

/** Where exports are published, as `--to` takes it. */
interface PublishTarget {
  /** `<registry>/<namespace>` with the registry declared, or a folder ending in `/<namespace>`. */
  to: string;
}

/** An exported artifact path, glob, or folder whose immediate artifacts are exported. */
export interface Export {
  /** Relative to the project, with `/`; only a plain entry may be a glob. */
  path: string;
  /** When set, every artifact the entry reaches must be this kind. */
  kind?: ArtifactKind | undefined;
  /** The exact version to publish it at, instead of the next one. */
  version: string | undefined;
  dependsOn: ExportDependency[];
  /** `false` keeps it in this repository; absent, it goes to `publish.to`. */
  publish: false | undefined;
  /** For a folder of artifacts, the names directly inside it that it does not reach. */
  exclude?: string[] | undefined;
  /** Gitignore patterns, relative to each artifact it reaches: the files left out. */
  ignore?: string[] | undefined;
  /** When set, the only files each artifact publishes besides its entry file, and where each is stored. */
  include?: ExportFile[] | undefined;
}

/** A local exported path or the unversioned address of a declared installed artifact. */
export type ExportDependency = { type: "local"; path: string } | { type: "remote"; ref: Ref };

export { type ExportFile, isGlob } from "./export-fields.ts";
export { ManifestError } from "./manifest-error.ts";

/** The published schema is held to this list. */
export const MANIFEST_KEYS = [
  "$schema",
  "name",
  "description",
  "engines",
  "harnesses",
  "registries",
  "artifacts",
  "exports",
  "publish",
] as const;

/** Every key a mapping in `exports:` takes. */
export const EXPORT_KEYS = [
  "path",
  "kind",
  "version",
  "depends_on",
  "publish",
  "exclude",
  "ignore",
  "include",
] as const;

/** Every transport's keys; which are legal together is checked below. */
export const REGISTRY_KEYS = ["source", "adapter", "ref", "path", "layout", "config"] as const;

const ARTIFACT_KEYS = ["ref", "as", "exclude", "harnesses", "copy", "trust"] as const;

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
    exports: [],
    publish: undefined,
  };
}

function refuseOldCli(engine: string | undefined): void {
  const why = unmetEngine(VERSION, engine);
  if (why === undefined) return;
  throw new AiregError(`This project ${why}.`, { hint: "Run `aireg self update`." });
}

function engineOf(raw: unknown): string | undefined {
  const value = isRecord(raw) ? raw[NAME] : undefined;
  return typeof value === "string" ? parseEngine(value) : undefined;
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
  const layout = optionalString(entry, "layout") ?? config.layout;
  if (layout !== undefined && !isLayoutId(layout)) {
    throw new ManifestError(
      `Registry ${quoted(alias)} has layout ${quoted(layout)}, which is not ${list([...LAYOUT_IDS], "or")}.`,
    );
  }
  return {
    location: address(alias, location),
    adapter: optionalString(entry, "adapter"),
    config: canonicalConfig({
      ...config,
      ...(ref === undefined ? {} : { ref }),
      ...(path === undefined ? {} : { path }),
      ...(layout === undefined ? {} : { layout }),
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
  onlyKnown(entry, ARTIFACT_KEYS, "An `artifacts:` entry");
  const text = optionalString(entry, "ref");
  if (text === undefined) throw new ManifestError("An `artifacts:` entry has no `ref`.");
  const localName = optionalString(entry, "as");
  const exclude = stringList(entry.exclude, text, "exclude");
  const targets = stringList(entry.harnesses, text, "harnesses");
  const trust = stringList(entry.trust, text, "trust");
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
  if (trust !== undefined) ref = { ...ref, trust };
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

/** Controls and characters that hide or reorder text: a registry's name is shown everywhere. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function parseRegistries(root: Record<string, unknown>): Record<string, RegistrySource> {
  const registries = root.registries;
  if (registries === undefined || registries === null) return {};
  if (typeof registries !== "object" || Array.isArray(registries)) {
    throw new ManifestError("`registries:` must map names to addresses.");
  }
  const unshowable = Object.keys(registries).filter((alias) => UNSHOWABLE.test(alias));
  if (unshowable.length > 0) {
    throw new ManifestError(
      `${list(unshowable.map(quoted))} cannot name a registry.`,
      "Rename each one and its `artifacts:` entries in manifest.yml, using lowercase letters, digits and hyphens, then run `aireg install`.",
    );
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

/** The `artifacts:` entry a remote dependency names: the same address, at any exact version. */
export function artifactFor(artifacts: readonly Ref[], ref: Ref): Ref | undefined {
  const address = formatAddress(ref);
  return artifacts.find((entry) => formatAddress(entry) === address);
}

function isFolderTarget(to: string): boolean {
  return to.startsWith(".") || to.startsWith("/");
}

function publishTo(raw: unknown, registries: Record<string, RegistrySource>): string {
  const where = "`publish.to`";
  if (Array.isArray(raw)) {
    const [first] = raw;
    const only = typeof first === "string" ? first : "acme/engineering";
    throw new ManifestError(
      `${where} names one target, not a list.`,
      raw.length === 1
        ? `Write it as \`to: ${only}\`.`
        : `Keep the one this project publishes to, such as \`to: ${only}\`.`,
    );
  }
  const to = textOf(raw);
  if (to === undefined) {
    throw new ManifestError(
      `${where} must be one target, such as acme/engineering or ./registry/engineering.`,
    );
  }
  checkTarget(to, where, registries);
  return to;
}

function checkTarget(to: string, where: string, registries: Record<string, RegistrySource>): void {
  const parts = to.split("/");
  const namespace = parts.at(-1) as string;
  if (isFolderTarget(to)) {
    if (parts.length < 2 || !isNamespace(namespace)) {
      throw new ManifestError(
        `${where} names ${quoted(to)}, a folder that does not end in a namespace.`,
        "End it with the namespace to publish under, such as ./registry/engineering.",
      );
    }
    return;
  }
  const [registry = ""] = parts;
  if (parts.length !== 2 || registry === "") {
    throw new ManifestError(
      `${where} names ${quoted(to)}, which is neither <registry>/<namespace> nor a folder.`,
      "Write it as acme/engineering, or start a folder with ./ or /.",
    );
  }
  if (registries[registry] === undefined) {
    throw new ManifestError(
      `${where} names registry ${quoted(registry)}, which is not declared under \`registries:\`.`,
      `Declare it with \`aireg registry add <address> --as ${registry}\`.`,
    );
  }
  if (!isNamespace(namespace)) {
    throw new ManifestError(
      `${where} names ${quoted(to)}, whose namespace is not valid.`,
      "Use lowercase letters, digits and inner hyphens, such as engineering.",
    );
  }
}

function parsePublish(
  raw: unknown,
  registries: Record<string, RegistrySource>,
): PublishTarget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new ManifestError("`publish:` must be a mapping with `to`.");
  onlyKnown(raw, ["to"], "`publish:`");
  if (raw.to === undefined || raw.to === null) throw new ManifestError("`publish:` has no `to`.");
  return { to: publishTo(raw.to, registries) };
}

function exportVersion(raw: unknown, path: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === "string" ? parseVersion(raw) : undefined;

  if (parsed === undefined || formatVersion(parsed) !== raw) {
    throw new ManifestError(
      `\`version\` of export ${quoted(path)} must be an exact version, such as 2.0.0.`,
    );
  }
  return raw;
}

function dependency(text: string, path: string, artifacts: readonly Ref[]): ExportDependency {
  const of = `Export ${quoted(path)} depends on ${quoted(text)}`;
  if (text.startsWith("./")) {
    const local = text.slice(2);
    const problem = pathProblem(local);
    if (problem !== undefined) throw new ManifestError(`${of}, whose path ${problem}.`, PATH_HINT);
    if (isGlob(local)) {
      throw new ManifestError(
        `${of}, a glob rather than a path.`,
        "Name an artifact, or a folder of them, such as ./skills.",
      );
    }
    if (local === path) throw new ManifestError(`Export ${quoted(path)} depends on itself.`);
    return { type: "local", path: local };
  }
  let ref: Ref | undefined;
  try {
    ref = parseRef(text);
  } catch (error) {
    if (!(error instanceof RefParseError)) throw error;
  }
  if (ref === undefined || ref.namespace === undefined || ref.kind === undefined) {
    throw new ManifestError(
      `${of}, which is neither ./<path> nor <registry>/<namespace>/<kind>/<name>.`,
      "Start a path in this project with ./, such as ./.claude/skills/review.",
    );
  }
  const address = formatAddress(ref);
  // Which versions it takes is the install's to say, so it is said once.
  if (ref.version !== undefined) {
    throw new ManifestError(
      `${of}, but its version belongs on its \`artifacts:\` entry.`,
      `Write ${address} here, and ${formatRef(ref)} under \`artifacts:\`.`,
    );
  }
  if (artifactFor(artifacts, ref) === undefined) {
    throw new ManifestError(
      `${of}, which is not listed under \`artifacts:\`.`,
      // Not `aireg add`, which reads this manifest first and so stops here too.
      `List it under \`artifacts:\`, such as \`- ${address}\`.`,
    );
  }
  return { type: "remote", ref };
}

function dependencies(raw: unknown, path: string, artifacts: readonly Ref[]): ExportDependency[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => textOf(item) === undefined)) {
    throw new ManifestError(
      `\`depends_on\` of export ${quoted(path)} must be a list of paths and addresses.`,
    );
  }
  const seen = new Set<string>();
  return (raw as string[]).map((text) => {
    if (seen.has(text)) {
      throw new ManifestError(
        `Export ${quoted(path)} lists ${quoted(text)} twice under \`depends_on\`.`,
      );
    }
    seen.add(text);
    return dependency(text, path, artifacts);
  });
}

function exportPublish(raw: unknown, path: string): false | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  // One target for the whole project, so an entry can only keep itself out of it.
  throw new ManifestError(
    `\`publish\` of export ${quoted(path)} takes only false.`,
    "Remove it to publish the export to `publish.to`, or write `publish: false` to keep it here.",
  );
}

function exportEntry(raw: unknown, artifacts: readonly Ref[]): Export {
  if (typeof raw === "string") {
    return { path: exportPath(raw), version: undefined, dependsOn: [], publish: undefined };
  }
  if (!isRecord(raw)) {
    throw new ManifestError("`exports:` entries must be paths or `{ path, ... }` mappings.");
  }
  onlyKnown(raw, EXPORT_KEYS, "An `exports:` entry");
  const text = optionalString(raw, "path");
  if (text === undefined) throw new ManifestError("An `exports:` entry has no `path`.");
  const path = exportPath(text);
  // A glob's members are refined by entries of their own, so one path never reads two ways.
  if (isGlob(path)) {
    throw new ManifestError(
      `Export ${quoted(path)} is a glob, which only a plain \`exports:\` entry can be.`,
      "Give each path it matches an entry of its own to set its version, dependencies or targets.",
    );
  }
  const optional = withoutUndefined({
    kind: exportKind(raw.kind, path),
    exclude: exportExclude(raw.exclude, path),
    ignore: exportIgnore(raw.ignore, path),
    include: exportInclude(raw.include, path),
  });
  return {
    path,
    version: exportVersion(raw.version, path),
    dependsOn: dependencies(raw.depends_on, path, artifacts),
    publish: exportPublish(raw.publish, path),
    ...optional,
  };
}

function exportPath(text: string): string {
  if (text.trim() === "") throw new ManifestError("An `exports:` entry has an empty path.");
  const problem = pathProblem(text);
  if (problem !== undefined) {
    throw new ManifestError(`Export ${quoted(text)} ${problem}.`, PATH_HINT);
  }
  return text;
}

function parseExports(raw: unknown, artifacts: readonly Ref[]): Export[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ManifestError("`exports:` must be a list of paths.");
  const seen = new Set<string>();
  return raw.map((item) => {
    const entry = exportEntry(item, artifacts);
    if (seen.has(entry.path)) {
      throw new ManifestError(`Export ${quoted(entry.path)} is listed more than once.`);
    }
    seen.add(entry.path);
    return entry;
  });
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
  try {
    return parseKnownFields(root);
  } catch (error) {
    // A key or form this aireg does not know is most likely one the newer
    // aireg the file asks for added, so that is the failure worth reporting.
    if (error instanceof ManifestError) refuseOldCli(engineOf(root.engines));
    throw error;
  }
}

function parseKnownFields(root: Record<string, unknown>): Manifest {
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
    exports: parseExports(root.exports, artifacts),
    publish: parsePublish(root.publish, registries),
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
    const { ref, path, layout, ...rest } = source.config;
    const written = withoutUndefined({
      source: source.location,
      adapter: source.adapter,
      ref,
      path,
      layout,
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
      trust: ref.trust?.length ? [...ref.trust].sort() : undefined,
    });
    return Object.keys(written).length === 1 ? formatRef(ref) : written;
  });
  if (manifest.exports.length > 0) doc.exports = manifest.exports.map(exportData);
  if (manifest.publish !== undefined) doc.publish = { to: manifest.publish.to };
  return doc;
}

function exportData(entry: Export): unknown {
  const written = withoutUndefined({
    path: entry.path,
    kind: entry.kind,
    version: entry.version,
    depends_on:
      entry.dependsOn.length === 0
        ? undefined
        : entry.dependsOn.map((need) =>
            need.type === "local" ? `./${need.path}` : formatAddress(need.ref),
          ),
    publish: entry.publish,
    exclude: entry.exclude,
    ignore: entry.ignore,
    include: entry.include?.map((file) => (file.from === file.as ? file.from : { ...file })),
  });
  return Object.keys(written).length === 1 ? entry.path : written;
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
  if (ref.version !== undefined || ref.localName !== undefined) {
    return false;
  }
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
