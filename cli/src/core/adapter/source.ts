import { extname, join } from "node:path";
import {
  AdapterError,
  type Artifact,
  type Credential,
  type Envelope,
  type EnvelopeMetadata,
  type FileDescriptor,
  isSafePath,
  type RegistryIdentity,
  type ResolveOptions,
  type SourceAdapter,
  type SourceContext,
  type SourceHandle,
  type Want,
} from "#adapter/index.ts";
import { collidingPaths } from "#adapter/paths.ts";
import { isDigest } from "#adapter/spec/ref.ts";
import { ENVELOPE_API_VERSION } from "#adapter/spec/types.ts";
import { quoted, sanitizeName, sanitizeText } from "#adapter/text.ts";
import type { Catalog, Entry } from "#core/catalog/model.ts";
import { emptyCatalog, finalize, merge } from "#core/catalog/model.ts";
import { withheldFrom } from "#core/catalog/withheld.ts";
import { bindAdapter } from "#core/hook/bind.ts";
import { KIND_SPECS, specKindDir } from "#core/kinds.ts";
import { withLease } from "#core/lease.ts";
import { engineFromUnknown } from "#core/semver.ts";
import { cacheDir, ensureHome } from "#core/store/paths.ts";
import { type SourceConfig, sourceKey } from "./identity.ts";
import { adapterFor, limitsFor } from "./registry.ts";

export interface DeclaredSource {
  alias: string;
  location: string;
  adapter: string | undefined;
  config: SourceConfig;
  /**
   * What the manifest says, where that differs from `location`. The key is taken
   * from this, so a committed lock records the same identity on every machine.
   */
  declared?: string | undefined;
}

/** What the host does for an adapter: a cache folder and one writer per key, across processes. */
export function hostServices(id: string): Pick<SourceContext, "limits" | "cacheDir" | "exclusive"> {
  return {
    limits: limitsFor(id),
    cacheDir: () => {
      ensureHome();
      return join(cacheDir(), id);
    },
    exclusive: (key, run) => withLease({ scope: "user", lock: key }, { wait: true }, run),
  };
}

export interface ConnectOptions {
  /** From `credentialFor`, which sends one only to the source it belongs to. */
  credential?: Credential | undefined;
  signal?: AbortSignal | undefined;
  onBytes?: ((count: number) => void) | undefined;
}

export interface ConnectedSource {
  adapter: SourceAdapter;
  handle: SourceHandle;
  key: string;
}

export async function connectSource(
  spec: DeclaredSource,
  options: ConnectOptions = {},
): Promise<ConnectedSource> {
  const adapter = await adapterFor(spec.location, spec.adapter);
  const key = sourceKey(spec.declared ?? spec.location, spec.config);
  const handle = await bindAdapter(adapter, spec.alias).connect({
    source: { registry: spec.alias, location: spec.location, config: spec.config, key },
    credential: options.credential,
    signal: options.signal ?? new AbortController().signal,
    onBytes: options.onBytes ?? (() => {}),
    ...hostServices(adapter.id),
  });
  return { adapter, handle, key };
}

/** One resolved artifact, keyed by the catalog entry everything else addresses it by. */
interface Listed {
  path: string;
  artifact: Artifact;
}

export interface Listing {
  catalog: Catalog;
  listed: Listed[];
  sourceRevision: string | undefined;
  registry: RegistryIdentity | undefined;
}

/**
 * The address the file spec gives this artifact inside its registry, which is
 * where its bytes sit in the mirror. File-shaped entries keep the extension.
 */
function entryPath(artifact: Artifact): string | undefined {
  // A plugin is its own namespace; anything else is filed under the one it
  // belongs to, and an artifact with neither is filed under its own name.
  const namespace = sanitizeName(
    artifact.kind === "plugin"
      ? artifact.envelope.metadata.name
      : (artifact.group ?? artifact.envelope.metadata.namespace ?? artifact.envelope.metadata.name),
  );
  const name = sanitizeName(artifact.envelope.metadata.name);
  const address = `artifacts/${namespace}/${specKindDir(artifact.kind)}/${name}`;
  if (KIND_SPECS[artifact.kind].shape === "directory") return address;

  const only = artifact.files.length === 1 ? artifact.files[0] : undefined;
  return only === undefined ? undefined : `${address}${extname(only.path)}`;
}

type Fail = (message: string) => never;

/**
 * Both directions, so neither an undescribed file nor an unreachable descriptor
 * surfaces halfway through a fetch.
 */
function checkFiles(envelope: Envelope, artifact: Artifact, fail: Fail): void {
  const described = new Map<string, FileDescriptor>();
  for (const descriptor of envelope.files) {
    if (!isSafePath(descriptor.path)) {
      fail(`describes an unusable file path: ${descriptor.path}`);
    }
    if (!isDigest(descriptor.digest)) {
      fail(
        `describes ${descriptor.path} with "${descriptor.digest}", which is not a sha256 digest`,
      );
    }
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
      fail(`describes ${descriptor.path} with a size of ${descriptor.size}`);
    }
    described.set(descriptor.path, descriptor);
  }
  const clash = collidingPaths([...described.keys()]);
  if (clash !== undefined) {
    fail(`describes ${quoted(clash[0])} and ${quoted(clash[1])}, which are one file on most disks`);
  }

  const published = new Set<string>();
  for (const file of artifact.files) {
    if (!isSafePath(file.path)) fail(`publishes an unusable file path: ${file.path}`);
    if (typeof file.locator !== "string" || file.locator === "") {
      fail(`publishes ${file.path} with no locator`);
    }
    if (!described.has(file.path)) fail(`publishes ${file.path}, which it does not describe`);
    published.add(file.path);
  }
  for (const path of described.keys()) {
    if (!published.has(path)) fail(`describes ${path}, which it does not publish`);
  }
}

/**
 * Everything an adapter returns is checked here, once, rather than by each
 * adapter in its own way. A backend that lies is named in the failure.
 */
function check(adapter: SourceAdapter, artifact: Artifact, index: number): void {
  const envelope: Envelope | undefined = artifact.envelope;
  const metadata: EnvelopeMetadata | undefined = envelope?.metadata;
  const name = typeof metadata?.name === "string" ? metadata.name : "";
  const where = name === "" ? `Artifact ${index}` : `Artifact ${quoted(name)}`;
  // Annotated so the compiler knows a failing check does not fall through.
  const fail: Fail = (message) => {
    const title = `${where} ${message}.`;
    throw new AdapterError(adapter.id, "invalid", title, {
      artifact: name,
      problem: { code: "SPEC_INVALID", title },
    });
  };

  if (typeof artifact.id !== "string" || artifact.id === "") fail("has no id");
  if (!adapter.artifactKinds.includes(artifact.kind)) {
    fail(`is a ${artifact.kind}, which ${adapter.displayName} does not serve`);
  }
  if (envelope === undefined || metadata === undefined) fail("has no file list");
  if (envelope.apiVersion !== ENVELOPE_API_VERSION) {
    fail(`has a file list in format ${quoted(envelope.apiVersion)}, not ${ENVELOPE_API_VERSION}`);
  }
  if (typeof envelope.kind !== "string" || envelope.kind === "")
    fail("has no kind in its file list");
  if (name === "") fail("has no name");
  if (!Array.isArray(envelope.files) || envelope.files.length === 0) fail("describes no files");
  if (!Array.isArray(artifact.files) || artifact.files.length === 0) fail("publishes no files");

  checkFiles(envelope, artifact, fail);
}

export async function resolveArtifacts(
  source: ConnectedSource,
  want: readonly Want[],
  options?: ResolveOptions,
): Promise<Listing> {
  const { adapter, handle } = source;
  const resolution = await handle.resolve(want, options);

  const catalog = emptyCatalog(adapter.id);
  const entries: Entry[] = [];
  const listed: Listed[] = [];
  const taken = new Map<string, Artifact>();

  for (const [index, artifact] of resolution.artifacts.entries()) check(adapter, artifact, index);

  for (const artifact of resolution.artifacts) {
    const { name, description } = artifact.envelope.metadata;
    const path = entryPath(artifact);
    if (path === undefined) {
      catalog.warnings.push(
        `${quoted(name)} is a ${artifact.kind}, which is one file, but ${artifact.files.length} were published.`,
      );
      continue;
    }

    // Sanitized names can collide; keep the first result deterministically.
    const owner = taken.get(path);
    if (owner !== undefined) {
      const held = owner.envelope.metadata.name;
      catalog.warnings.push(
        `${quoted(name)} (${quoted(artifact.id)}) and ${quoted(held)} (${quoted(owner.id)}) are both ` +
          `addressed as ${path}; keeping ${quoted(held)}.`,
      );
      continue;
    }
    taken.set(path, artifact);

    entries.push({
      name: sanitizeName(name),
      kind: artifact.kind,
      path,
      group: artifact.group === undefined ? undefined : sanitizeName(artifact.group),
      description: description === undefined ? undefined : sanitizeText(description),
      engine: engineFromUnknown(artifact.engines),
      from: { file: adapter.id, pointer: artifact.id },
    });
    listed.push({ path, artifact });
  }

  merge(catalog, adapter.id, entries);
  const withheld = withheldFrom(resolution.withheld);
  if (withheld.length > 0) catalog.withheld = withheld;
  return {
    catalog: finalize(catalog),
    listed,
    sourceRevision: adapter.capabilities.pinsSource ? resolution.sourceRevision : undefined,
    registry: identity(resolution.registry),
  };
}

/** Only what could be a name or a label; a backend's other fields are not read. */
function identity(raw: RegistryIdentity | undefined): RegistryIdentity | undefined {
  if (raw === undefined || typeof raw.name !== "string" || raw.name.trim() === "") return undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? sanitizeText(value) : undefined;
  const slug = text(raw.slug);
  const description = text(raw.description);
  return {
    name: sanitizeText(raw.name),
    ...(slug === undefined ? {} : { slug }),
    ...(description === undefined ? {} : { description }),
  };
}
