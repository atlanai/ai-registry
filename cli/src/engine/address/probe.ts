import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { credentialFor, credentialForLocation } from "#accounts/credentials.ts";
import { adapterOf, isAuthFailure, messageOf } from "#adapter/errors.ts";
import { type ArtifactPlace, artifactAt, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import {
  isAdapterError,
  type RegistryIdentity,
  type SourceAdapter,
  type Want,
} from "#adapter/index.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { isLayoutId, isReadOnlyLayout, LAYOUT_IDS, type LayoutId } from "#adapter/layouts/ids.ts";
import { registryNameFromLocation } from "#adapter/location.ts";
import { expandHome, isLocalPath } from "#adapter/paths.ts";
import { contentDigest } from "#adapter/spec/canonical.ts";
import {
  list,
  plural,
  quoted,
  sanitizeName,
  stripLeading,
  stripTrailing,
  withoutCredentials,
} from "#adapter/text.ts";
import { ID as GIT, pastedRepository, settlePastedLink } from "#adapters/git/api.ts";
import { connectSource, type Listing, resolveArtifacts } from "#core/adapter/connect.ts";
import { canonicalConfig } from "#core/adapter/identity.ts";
import { declaredLayout, limitsFor, loadAdapter } from "#core/adapter/load.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { materialize } from "#core/adapter/materialize.ts";
import type { Catalog, Entry } from "#core/catalog/catalog.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { findRegistry } from "#core/filespec/init.ts";
import { dotRelative, posixRelative } from "#core/fs/path.ts";
import { kindSpec, knownKinds } from "#core/kinds.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { manifestOf } from "#core/plan/acquire/placement.ts";
import { type Carried, carriedIn } from "#core/plan/carries.ts";
import { wrapsNamespaces } from "#core/plan/namespaces.ts";
import { unmatched } from "#core/plan/select.ts";
import { parseRef, type Ref } from "#core/ref.ts";
import { ensureHome, stagingPath } from "#core/store/paths.ts";

export interface SourceFlags extends Record<string, unknown> {
  adapter?: string | undefined;
  config?: string[] | undefined;
  ref?: string | undefined;
  path?: string | undefined;
  layout?: string | undefined;
}

export interface Probed {
  alias: string;
  /** Whether the alias is the registry's own name or derived from the address. */
  named: "registry" | "address";
  label: string | undefined;
  location: string;
  declared: RegistrySource;
  catalog: Catalog;
  /** Set only when the source reports one revision covering everything. */
  revision: string | undefined;
  layout: LayoutId | undefined;
  /** The adapter declares each namespace a plugin, which the user scope installs as one. */
  namespacePlugins: boolean;
  versionOf: (entry: Entry) => string | undefined;
  labelsOf: (entry: Entry) => Readonly<Record<string, string>> | undefined;
  /** What a plugin from a source that is not a registry would have a target start. */
  carriesOf: (entry: Entry) => readonly Carried[];
  /** Fetches the entry's bytes if they are not staged yet. */
  stage: (entry: Entry) => Promise<string>;
  adapter: string;
  digestOf: (want: Want) => Promise<string | undefined>;
  close: () => Promise<void>;
}

/** Flags win over `--config` entries. */
export function sourceConfig(flags: SourceFlags) {
  const config: Record<string, string> = {};
  for (const value of flags.config ?? []) {
    const at = value.indexOf("=");
    if (at < 1)
      throw new AiregError(`--config takes <key>=<value>, not ${quoted(value)}.`, {
        code: ErrorCode.Usage,
        hint: "Pass one setting per `--config`, such as `--config ref=main`.",
      });
    config[value.slice(0, at)] = value.slice(at + 1);
  }
  if (flags.ref !== undefined) config.ref = flags.ref;
  if (flags.path !== undefined) config.path = stripLeading(stripTrailing(flags.path, "/"), "/");
  if (flags.layout !== undefined) {
    if (!isLayoutId(flags.layout)) {
      throw new AiregError(
        `--layout takes ${list([...LAYOUT_IDS], "or")}, not ${quoted(flags.layout)}.`,
        {
          code: ErrorCode.Usage,
          hint: "Leave it off to let aireg tell the layout from what the source holds.",
        },
      );
    }
    config.layout = flags.layout;
  }
  return canonicalConfig(config);
}

/** Keep the declared location; take probe flags so `--ref` survives acquire. */
export function rememberSource(
  existing: RegistrySource | undefined,
  probed: RegistrySource,
): RegistrySource {
  if (existing === undefined) return probed;
  return { ...existing, config: probed.config };
}

/** Checks declared aliases first, or the address's first segment reaches git as a repository. */
export function throughManifest(
  input: string,
  registries: Readonly<Record<string, RegistrySource>>,
  flags: SourceFlags,
): Resolved {
  const alias = aliasIn(input);
  const source = registries[alias];
  if (source === undefined) {
    return {
      input,
      flags,
      name: undefined,
      version: undefined,
      declared: false,
      alias: undefined,
      aliases: Object.keys(registries),
    };
  }

  let ref: Ref;
  try {
    ref = parseRef(input);
  } catch (cause) {
    // A versioned address asked for one thing, so never fall back to the whole registry.
    if (input.includes("@")) throw cause;
    // A declared alias with an address we cannot read is still that alias.
    return {
      input: source.location,
      flags: overlay(source, flags),
      name: undefined,
      version: undefined,
      declared: true,
      alias,
      aliases: Object.keys(registries),
    };
  }
  // A lockfile or manifest row may name any kind; an address a person typed names a known one.
  if (ref.kind !== undefined && kindSpec(ref.kind) === undefined) {
    throw new AiregError(`${quoted(ref.kind)} in ${quoted(input)} is not a kind aireg knows.`, {
      code: ErrorCode.Usage,
      hint: `Use ${list(knownKinds(), "or")}, or install the adapter that declares it.`,
    });
  }
  return {
    input: source.location,
    flags: overlay(source, flags),
    name: ref.name,
    ...(ref.name === undefined ? {} : { namespace: ref.namespace, kind: ref.kind }),
    version: ref.version,
    declared: true,
    alias,
    aliases: Object.keys(registries),
  };
}

/** Split before the version, so `house@1.0.0` still names its alias. */
export function aliasIn(address: string): string {
  return (address.split("@")[0] ?? address).split("/")[0] ?? address;
}

/** Flags win over the manifest, so `--ref` can override a pinned registry. */
function overlay(declared: RegistrySource, flags: SourceFlags): SourceFlags {
  const config = Object.entries(declared.config).map(([key, value]) => `${key}=${value}`);
  return {
    adapter: flags.adapter ?? declared.adapter,
    config: [...config, ...(flags.config ?? [])],
    ref: flags.ref,
    path: flags.path,
    layout: flags.layout,
  };
}

export interface Resolved {
  input: string;
  flags: SourceFlags;
  name: string | undefined;
  namespace?: string | undefined;
  kind?: ArtifactKind | undefined;
  version: string | undefined;
  declared: boolean;
  /** The declared alias, whose account reads the registry. */
  alias: string | undefined;
  /** Every declared alias, any of which may hold the token. */
  aliases: readonly string[];
}

/** Parses what follows a registry's name; the placeholder segment stands in for it. */
export function relativeRef(address: string): Ref {
  try {
    return parseRef(`registry/${address}`);
  } catch (cause) {
    throw new AiregError(`${quoted(address)} is not an address inside a registry.`, {
      code: ErrorCode.Usage,
      hint: "Write what follows the registry's name: `<namespace>[/<kind>]/<name>[@<version>]`.",
      cause,
    });
  }
}

export function throughRegistry(
  registry: string,
  address: string,
  registries: Readonly<Record<string, RegistrySource>>,
  flags: SourceFlags,
): Resolved {
  const ref = relativeRef(address);
  if (registries[registry] !== undefined) {
    return throughManifest(`${registry}/${address}`, registries, flags);
  }
  return {
    input: registry,
    flags,
    name: ref.name,
    ...(ref.name === undefined ? {} : { namespace: ref.namespace, kind: ref.kind }),
    version: ref.version,
    declared: false,
    alias: undefined,
    aliases: Object.keys(registries),
  };
}

/** Never a silent pick: a name two kinds or two namespaces share is refused. */
export function among(
  entries: readonly Entry[],
  alias: string,
  want: { name: string; namespace?: string | undefined; kind?: string | undefined },
): Entry[] {
  const name = sanitizeName(want.name);
  const namespace = want.namespace === undefined ? undefined : sanitizeName(want.namespace);
  const found = entries.filter(
    (entry) =>
      entry.name === name &&
      (namespace === undefined || entry.group === namespace) &&
      (want.kind === undefined ? entry.kind !== "plugin" : entry.kind === want.kind),
  );
  const addresses = [
    ...new Set(
      found.map((entry) => [alias, entry.group, entry.kind, entry.name].filter(Boolean).join("/")),
    ),
  ].sort();
  if (addresses.length > 1) {
    throw new AiregError(
      `${alias}/${[want.namespace, want.kind, want.name].filter(Boolean).join("/")} matches ${plural(addresses.length, "artifact")}.`,
      {
        code: ErrorCode.Usage,
        hint: `Name one of them: ${list(addresses, "or")}.`,
      },
    );
  }
  return found;
}

/** Every artifact of the name, so a miss can say which was meant; the version on the named one. */
export function wantOf(resolved: Resolved): Want[] {
  if (resolved.name === undefined) return [];
  const named = { name: resolved.name };
  if (resolved.version === undefined) return [named];
  const { namespace, kind, version } = resolved;
  return [named, { ...named, namespace, kind, version }];
}

/**
 * A version with no kind is asked of every kind of that name, so one that lacks it fails the read;
 * a bare read then checks whether two kinds share the name.
 */
export async function probeAddress(
  resolved: Resolved,
  cwd: string,
  want: readonly Want[],
): Promise<Probed> {
  const { input, flags } = resolved;
  const read = (asked: readonly Want[]) =>
    probe({ input, flags, cwd, want: asked, declared: resolved });
  try {
    return await read(want);
  } catch (error) {
    const { name, namespace, kind } = resolved;
    const versioned = want.some((item) => item.version !== undefined);
    if (!versioned || kind !== undefined || name === undefined) throw error;
    const failure = adapterOf(error)?.failure;
    if (failure !== "invalid" && failure !== "not_found") throw error;
    // The first failure is the one to report, whatever this read hits.
    const bare = await read([{ name }]).catch(() => undefined);
    if (bare === undefined) throw error;
    try {
      among(bare.catalog.entries, resolved.alias ?? bare.alias, { name, namespace });
    } finally {
      await bare.close();
    }
    throw error;
  }
}

/** A namespace is an owner, so an address it does not hold never falls back to another's. */
export function atAddress(resolved: Resolved, entries: readonly Entry[], alias: string): Entry[] {
  if (resolved.name === undefined) return [...entries];
  const { name, namespace, kind, version } = resolved;
  const found = among(entries, alias, { name, namespace, kind });
  if (found.length > 0) return found;
  const { message, guess } = unmatched(
    { registry: alias, namespace, kind, name, version },
    entries,
  );
  const show = `Run \`aireg registry show ${alias}\` to see what it publishes.`;
  throw new AiregError(message, {
    code: ErrorCode.NotFound,
    hint: guess === "" ? show : `${guess} ${show}`,
  });
}

/** A pasted link or folder naming one artifact; its registry is the folder above `artifacts`. */
export async function insideRegistry(
  input: string,
  cwd: string,
): Promise<ArtifactLink | undefined> {
  const pasted = pastedRepository(input.replace(/#.*$/, ""));
  if (pasted?.path !== undefined && artifactAt(pasted.path) !== undefined) {
    const settled = await settlePastedLink(pasted, limitsFor(GIT));
    const place = settled?.path === undefined ? undefined : artifactAt(settled.path);
    if (settled === undefined || place === undefined) return undefined;
    return {
      registry: settled.location,
      flags: {
        ...(settled.ref === undefined ? {} : { ref: settled.ref }),
        ...(place.root === "" ? {} : { path: place.root }),
      },
      address: addressOf(place),
    };
  }

  if (!isLocalPath(input)) return undefined;
  const folder = expandLocation(input, cwd);
  if (!existsSync(folder) || existsSync(join(folder, REGISTRY_DOCUMENT))) return undefined;
  const root = findRegistry(folder);
  // A folder outside any registry is a source of its own, such as a folder of skills.
  if (root === undefined) return undefined;
  const place = artifactAt(posixRelative(root, folder));
  if (place === undefined || place.root !== "") {
    throw new AiregError(`${input} is inside the registry at ${root}, but names no artifact.`, {
      code: ErrorCode.Usage,
      hint: "Name an artifact's folder, artifacts/<namespace>/<kind>/<name>, or a version folder inside it.",
    });
  }
  // Typed relative stays relative, so the manifest records it relative to the project.
  const typedAbsolute = input.startsWith("~") || isAbsolute(expandHome(input));
  const registry = typedAbsolute ? root : dotRelative(cwd, root);
  return { registry, flags: {}, address: addressOf(place) };
}

export interface ArtifactLink {
  registry: string;
  /** Where in a pasted repository the registry sits. */
  flags: SourceFlags;
  /** `<namespace>/<kind>/<name>[@<version>]` */
  address: string;
}

function addressOf(place: ArtifactPlace): string {
  const address = `${place.namespace}/${place.kind}/${place.name}`;
  return place.version === undefined ? address : `${address}@${place.version}`;
}

export interface ProbeOptions {
  input: string;
  flags: SourceFlags;
  cwd: string;
  /** Empty asks for everything. */
  want?: readonly Want[] | undefined;
  /** A declared registry reads with its own account; two aliases can share one address. */
  declared?: Pick<Resolved, "alias" | "aliases"> | undefined;
}

/** Resolving and fetching are separate, so listing hundreds of artifacts downloads none. */
export async function probe({
  input,
  flags,
  cwd,
  want = [],
  declared,
}: ProbeOptions): Promise<Probed> {
  const declaredAlias = declared?.alias;
  const pasted = await settlePastedLink(
    pastedRepository(input.replace(/#.*$/, "")),
    limitsFor(GIT),
  );
  const config = sourceConfig({
    ...flags,
    ref: flags.ref ?? pasted?.ref,
    path: flags.path ?? pasted?.path,
  });
  const adapter = flags.adapter?.trim() === "" ? undefined : flags.adapter?.trim();
  const location = pasted === undefined ? expandLocation(input, cwd) : pasted.location;
  let open: Awaited<ReturnType<typeof connectSource>>;
  let listing: Listing;
  let alias = declaredAlias ?? registryNameFromLocation(location, adapter ?? "registry");
  const layout = declaredAlias === undefined ? config.layout : declaredLayout(config);
  try {
    // An undeclared address has no alias yet, so its account is found by address.
    const credential =
      declared?.alias === undefined
        ? await credentialForLocation(location, alias, { adapter })
        : await credentialFor(declared.alias, { adapter, config }, location, declared.aliases);
    open = await connectSource(
      { alias, location, adapter, config, layout },
      credential === undefined ? {} : { credential },
    );
    alias = declaredAlias ?? registryNameFromLocation(location, open.adapter.id);
    listing = await resolveArtifacts(open, want);
  } catch (cause) {
    if (cause instanceof AiregError) throw cause;
    const failure = isAdapterError(cause) ? cause.failure : undefined;
    const refused = isAuthFailure(failure);
    // Only the hint depends on the adapter, so one that will not load gets the general one.
    const failed =
      refused && isAdapterError(cause)
        ? await loadAdapter(cause.adapter).catch(() => undefined)
        : undefined;
    throw new AiregError(messageOf(cause), {
      cause,
      ...(refused
        ? {
            code: ErrorCode.Unauthorized,
            hint:
              failed?.credentialsHint ??
              `Run \`aireg auth login ${alias} --address ${withoutCredentials(location)}\`, then try again.`,
          }
        : {}),
    });
  }

  const own = ownName(listing.registry);
  const recorded = withLayout(config, listing.layout, open.adapter);
  const listedAt = (entry: Entry) =>
    listing.listed.find((candidate) => candidate.path === entry.path);
  // `digestOf` asks one want at a time, so a missing version does not hide the rest.
  return {
    alias: declaredAlias ?? own ?? alias,
    named: declaredAlias === undefined && own !== undefined ? "registry" : "address",
    label: labelOf(listing.registry, declaredAlias ?? own ?? alias),
    location,
    declared: { location, adapter, config: recorded },
    catalog: listing.catalog,
    revision: listing.sourceRevision,
    layout: listing.layout,
    namespacePlugins: wrapsNamespaces(open.adapter),
    versionOf: (entry) => {
      const artifact = listedAt(entry)?.artifact;
      return artifact?.version ?? artifact?.envelope.metadata.version;
    },
    labelsOf: (entry) => listedAt(entry)?.artifact.envelope.metadata.labels,
    carriesOf: (entry) => {
      const artifact = listedAt(entry)?.artifact;
      if (artifact?.kind !== "plugin" || !isReadOnlyLayout(listing.layout)) return [];
      return carriedIn(artifact.envelope, manifestOf(artifact)).carries;
    },
    stage: async (entry) => {
      const item = listedAt(entry);
      if (item === undefined) {
        throw new AiregError(`The registry at ${location} has no content for ${entry.name}.`, {
          code: ErrorCode.NotFound,
        });
      }
      ensureHome();
      return (
        await materialize(open.adapter.id, open.handle, item.artifact, {
          into: (content) => stagingPath(content),
        })
      ).path;
    },
    adapter: open.adapter.id,
    digestOf: async (wanted) => {
      try {
        const [item] = (await resolveArtifacts(open, [wanted])).listed;
        return item === undefined ? undefined : contentDigest(item.artifact.envelope);
      } catch (cause) {
        if (adapterOf(cause)?.failure === "not_found") return undefined;
        throw cause;
      }
    },
    close: () => open.handle.close(),
  };
}

function ownName(registry: RegistryIdentity | undefined): string | undefined {
  const raw = registry?.slug ?? registry?.name;
  return raw === undefined ? undefined : sanitizeName(raw);
}

/**
 * Detection runs once: a non-registry layout is recorded so later runs read it the same way.
 * A registry is the default and is recorded only when forced.
 */
function withLayout(
  config: Readonly<Record<string, string>>,
  layout: LayoutId | undefined,
  adapter: SourceAdapter,
): Record<string, string> {
  const takes = adapter.configSchema?.properties?.layout !== undefined;
  if (!takes || layout === undefined || layout === "registry" || config.layout !== undefined) {
    return { ...config };
  }
  return canonicalConfig({ ...config, layout });
}

function labelOf(registry: RegistryIdentity | undefined, alias: string): string | undefined {
  if (registry?.description !== undefined) return registry.description;
  return registry?.name === undefined || sanitizeName(registry.name) === alias
    ? undefined
    : registry.name;
}
