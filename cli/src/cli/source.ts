import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { credentialFor, credentialForLocation } from "#accounts/credentials.ts";
import { isAuthFailure } from "#adapter/errors.ts";
import { type ArtifactPlace, artifactAt, REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import {
  isAdapterError,
  type RegistryIdentity,
  type SourceAdapter,
  type Want,
} from "#adapter/index.ts";
import { isLayoutId, isReadOnlyLayout, LAYOUT_IDS, type LayoutId } from "#adapter/layouts/ids.ts";
import { registryNameFromLocation } from "#adapter/location.ts";
import { expandHome, isLocalPath } from "#adapter/paths.ts";
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
import { materialize } from "#core/adapter/content.ts";
import { canonicalConfig } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { declaredLayout, limitsFor, loadAdapter } from "#core/adapter/registry.ts";
import { connectSource, type Listing, resolveArtifacts } from "#core/adapter/source.ts";
import type { Catalog, Entry } from "#core/catalog/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { findRegistry } from "#core/filespec/write/init.ts";
import { dotRelative, posixRelative } from "#core/fs/path.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { manifestOf } from "#core/plan/acquire.ts";
import { type Carried, carriedIn } from "#core/plan/carries.ts";
import { wrapsNamespaces } from "#core/plan/namespaces.ts";
import { unmatched } from "#core/plan/select.ts";
import { parseRef, type Ref } from "#core/ref.ts";
import { ensureHome, stagingPath } from "#core/store/paths.ts";
import { adapterOf } from "./report.ts";

export interface SourceFlags extends Record<string, unknown> {
  adapter?: string | undefined;
  config?: string[] | undefined;
  ref?: string | undefined;
  path?: string | undefined;
  layout?: string | undefined;
}

export interface Probed {
  /** Default registry name, used when this is written into a manifest. */
  alias: string;
  /** Whether that name is the registry's own, or only derived from the address. */
  named: "registry" | "address";
  /** What the registry says it is, shown beside its name. */
  label: string | undefined;
  location: string;
  declared: RegistrySource;
  catalog: Catalog;
  /** Set only when the source reports one revision covering everything. */
  revision: string | undefined;
  /** How the source lays out what it holds, when its adapter says. */
  layout: LayoutId | undefined;
  /** Its adapter declares each namespace a plugin, which the user scope installs as one. */
  namespacePlugins: boolean;
  /** The version the source serves an entry at, which `@<version>` can pin. */
  versionOf: (entry: Entry) => string | undefined;
  /** The spec's indexable string pairs on an entry, which a search reads as tags. */
  labelsOf: (entry: Entry) => Readonly<Record<string, string>> | undefined;
  /** What a plugin from a source that is not a registry would have a harness start. */
  carriesOf: (entry: Entry) => readonly Carried[];
  /** The bytes an entry names, fetched now if they are not already here. */
  content: (entry: Entry) => Promise<string>;
  close: () => Promise<void>;
}

/** Manifest `config:` plus `--ref` / `--path`. Flags win. */
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

/** A registry's slug, else its name made identifier-safe: the name clients use for it. */
function ownName(registry: RegistryIdentity | undefined): string | undefined {
  const raw = registry?.slug ?? registry?.name;
  return raw === undefined ? undefined : sanitizeName(raw);
}

/** The description, else a name that says more than the alias already does. */
function labelOf(registry: RegistryIdentity | undefined, alias: string): string | undefined {
  if (registry?.description !== undefined) return registry.description;
  return registry?.name === undefined || sanitizeName(registry.name) === alias
    ? undefined
    : registry.name;
}

export interface Resolved {
  /** What to hand `probe`, whichever way the registry was named. */
  input: string;
  flags: SourceFlags;
  /** The artifact the address singled out, when it named one. */
  name: string | undefined;
  /** The namespace and kind the address wrote, which narrow that name. */
  namespace?: string | undefined;
  kind?: ArtifactKind | undefined;
  /** The version that address pinned, when it carried one. */
  version: string | undefined;
  /** Whether the address named a registry this scope already declares. */
  declared: boolean;
  /** The declared alias, whose account is the one to read with. */
  alias: string | undefined;
}

/**
 * An address may name a registry this scope already declares; otherwise its first
 * segment would reach the git adapter as a repository name.
 */
export function throughManifest(
  input: string,
  registries: Readonly<Record<string, RegistrySource>>,
  flags: SourceFlags,
): Resolved {
  // Split before the version, so `house@1.0.0` still finds the alias it names
  // and is answered by the reference grammar rather than by the URL parser.
  const alias = (input.split("@")[0] ?? input).split("/")[0] ?? input;
  const source = registries[alias];
  if (source === undefined) {
    return { input, flags, name: undefined, version: undefined, declared: false, alias: undefined };
  }

  let ref: Ref;
  try {
    ref = parseRef(input);
  } catch (cause) {
    // An address carrying a version said plainly what it wanted, so falling
    // back to the whole registry would install the opposite of the ask.
    if (input.includes("@")) throw cause;
    // A declared alias with an address we cannot read is still that alias.
    return {
      input: source.location,
      flags: overlay(source, flags),
      name: undefined,
      version: undefined,
      declared: true,
      alias,
    };
  }
  return {
    input: source.location,
    flags: overlay(source, flags),
    name: ref.name,
    ...(ref.name === undefined ? {} : { namespace: ref.namespace, kind: ref.kind }),
    version: ref.version,
    declared: true,
    alias,
  };
}

/**
 * What follows a registry's name in an address, read on its own. Any one-segment
 * name stands in for the registry, so only the rest is parsed.
 */
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

/**
 * `--registry` names the registry apart from the address, which is then whatever
 * follows the registry's name. A source is declared later, under its own name.
 */
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
  };
}

/**
 * The entries a name picks out, narrowed by the namespace and kind written beside
 * it. Never a silent pick: a name two kinds or two namespaces share is refused.
 */
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

/**
 * What to read for one address: every artifact of its name, so a miss can say
 * which one was meant, and the version only on the one the address names.
 */
export function wantOf(resolved: Resolved): Want[] {
  if (resolved.name === undefined) return [];
  const named = { name: resolved.name };
  if (resolved.version === undefined) return [named];
  const { namespace, kind, version } = resolved;
  return [named, { ...named, namespace, kind, version }];
}

/**
 * Reads what one address names. A version with no kind is asked of every kind of that
 * name, so one that lacks it fails the read; when two kinds share the name, that is the problem.
 */
export async function probeAddress(
  resolved: Resolved,
  cwd: string,
  want: readonly Want[],
): Promise<Probed> {
  try {
    return await probe(resolved.input, resolved.flags, cwd, want, resolved.alias);
  } catch (error) {
    const { name, namespace, kind } = resolved;
    const versioned = want.some((item) => item.version !== undefined);
    if (!versioned || kind !== undefined || name === undefined) throw error;
    const failure = adapterOf(error)?.failure;
    if (failure !== "invalid" && failure !== "not_found") throw error;
    // Read again only after such a failure, so a versioned address costs one read otherwise.
    const bare = await probe(resolved.input, resolved.flags, cwd, [{ name }], resolved.alias).catch(
      () => undefined,
    );
    if (bare === undefined) throw error;
    try {
      among(bare.catalog.entries, resolved.alias ?? bare.alias, { name, namespace });
    } finally {
      await bare.close();
    }
    throw error;
  }
}

/**
 * The entries one address names; with no name, the whole catalog. A namespace
 * is an owner, so an address it does not hold never falls back to another's.
 */
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

export interface ArtifactLink {
  /** The registry's address, what `--registry` would take. */
  registry: string;
  /** Where in a repository the registry sits, from a pasted link. */
  flags: SourceFlags;
  /** The artifact inside it: `<namespace>/<kind>/<name>[@<version>]`. */
  address: string;
}

/**
 * A pasted link or a folder that points at one artifact inside a registry, not
 * at the registry: the registry is the folder above `artifacts`, holding registry.json.
 */
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
  // A folder no registry holds is a source of its own, such as a folder of skills.
  if (root === undefined) return undefined;
  const place = artifactAt(posixRelative(root, folder));
  if (place === undefined || place.root !== "") {
    throw new AiregError(`${input} is inside the registry at ${root}, but names no artifact.`, {
      code: ErrorCode.Usage,
      hint: "Name an artifact's folder, artifacts/<namespace>/<kind>/<name>, or a version folder inside it.",
    });
  }
  // Typed relative, it stays relative, so the manifest records it relative to the project.
  const typedAbsolute = input.startsWith("~") || isAbsolute(expandHome(input));
  const registry = typedAbsolute ? root : dotRelative(cwd, root);
  return { registry, flags: {}, address: addressOf(place) };
}

function addressOf(place: ArtifactPlace): string {
  const address = `${place.namespace}/${place.kind}/${place.name}`;
  return place.version === undefined ? address : `${address}@${place.version}`;
}

/**
 * Detection runs once: a layout other than a registry is recorded with the source, so every later
 * run reads it the same way. A registry is the default and is recorded only when forced.
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

/**
 * Reads a registry without installing it: resolving and fetching are
 * separate, so listing hundreds of artifacts does not download them.
 */
export async function probe(
  input: string,
  flags: SourceFlags,
  cwd: string,
  /** What to ask for, at the version wanted. Empty asks for everything. */
  want: readonly Want[] = [],
  /** A declared registry reads with its own account; two aliases can share one address. */
  declaredAlias?: string,
): Promise<Probed> {
  // A pasted link names the repository, a ref and a folder; each is recorded where it belongs.
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
      declaredAlias === undefined
        ? await credentialForLocation(location, alias, { adapter })
        : await credentialFor(declaredAlias, { adapter, config }, location);
    open = await connectSource(
      { alias, location, adapter, config, layout },
      credential === undefined ? {} : { credential },
    );
    alias = declaredAlias ?? registryNameFromLocation(location, open.adapter.id);
    listing = await resolveArtifacts(open, want);
  } catch (cause) {
    // A refusal of our own already carries its code and what to do.
    if (cause instanceof AiregError) throw cause;
    const failure = isAdapterError(cause) ? cause.failure : undefined;
    const refused = isAuthFailure(failure);
    const failed =
      refused && isAdapterError(cause)
        ? await loadAdapter(cause.adapter).catch(() => undefined)
        : undefined;
    throw new AiregError(String((cause as Error).message), {
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
    content: async (entry) => {
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
    close: () => open.handle.close(),
  };
}
