import { isNamespace } from "#adapter/filespec/names.ts";
import { isLayoutId, LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import { list, quoted, sanitizeName } from "#adapter/text.ts";
import { canonicalConfig, type SourceConfig } from "#core/adapter/identity.ts";
import { parseEngine, unmetEngine } from "#core/engines.ts";
import { AiregError } from "#core/errors.ts";
import { dict, isRecord, RESERVED_KEYS, textMapOf, textOf } from "#core/fields.ts";
import { NAME } from "#core/product.ts";
import {
  formatAddress,
  formatRef,
  parseRef,
  type Ref,
  withExclusions,
  withLocalName,
} from "#core/ref.ts";
import { VERSION } from "#core/version.ts";
import { parseYaml } from "#core/yaml.ts";
import { ManifestError } from "./errors.ts";
import { parseExports } from "./exports.ts";
import { address, onlyKnown, optionalString, stringList } from "./field-guards.ts";
import {
  ARTIFACT_KEYS,
  emptyManifest,
  LEGACY_TARGETS_KEY,
  MANIFEST_KEYS,
  type Manifest,
  type PublishTarget,
  REGISTRY_KEYS,
  type RegistrySource,
} from "./model.ts";

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
  const targets = parseSelection(selectionOf(root, "The manifest"), "targets");

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
  // A registry's installed copies live in a folder named after it, and `Team` and `team`
  // name one folder: sharing it, either could read the other's copies as its own.
  const folders = new Map<string, string>();
  for (const [alias, raw] of Object.entries(registries as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(alias)) {
      throw new ManifestError(`${quoted(alias)} cannot name a registry.`);
    }
    const folder = sanitizeName(alias);
    const other = folders.get(folder);
    if (other !== undefined) {
      throw new ManifestError(
        `Registries ${quoted(other)} and ${quoted(alias)} would share the folder .registry/artifacts/${folder}.`,
        "Rename one of them and its `artifacts:` entries in manifest.yml, using lowercase letters, digits and hyphens, then run `aireg install`.",
      );
    }
    folders.set(folder, alias);
    out[alias] = parseSource(alias, raw);
  }
  return out;
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

/** Names are checked against the target table, which the parser does not load. */
function parseSelection(raw: unknown, key: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`\`${key}:\` must be a list of target names.`);
  return raw.map((entry) => {
    if (typeof entry !== "string") throw new ManifestError(`\`${key}:\` must list target names.`);
    return entry;
  });
}

/** `targets:`, or the earlier `harnesses:`; a mapping with both is ambiguous. */
function selectionOf(entry: Record<string, unknown>, where: string): unknown {
  const current = entry.targets;
  const legacy = entry[LEGACY_TARGETS_KEY];
  if (current != null && legacy != null) {
    throw new ManifestError(
      `${where} has both \`targets:\` and \`${LEGACY_TARGETS_KEY}:\`, which is its earlier name.`,
      `Keep \`targets:\` and delete \`${LEGACY_TARGETS_KEY}:\`.`,
    );
  }
  return current ?? legacy;
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
  const targets = stringList(selectionOf(entry, `Artifact ${quoted(text)}`), text, "targets");
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

function isFolderTarget(to: string): boolean {
  return to.startsWith(".") || to.startsWith("/");
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
