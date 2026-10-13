import { covers } from "#adapter/contract.ts";
import { adapterProblem, isAuthFailure } from "#adapter/errors.ts";
import {
  AdapterError,
  type Artifact,
  type Credential,
  contentDigest,
  isAdapterError,
  type Want,
} from "#adapter/index.ts";
import { quoted, sanitizeName, sanitizeText } from "#adapter/text.ts";
import { materialize } from "#core/adapter/content.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { loadAdapter } from "#core/adapter/registry.ts";
import { connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import type { Entry } from "#core/catalog/model.ts";
import { tokenVariable } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest, RegistrySource } from "#core/manifest.ts";
import { abbreviate } from "#core/output.ts";
import { formatAddress, type Ref } from "#core/ref.ts";
import { ensureHome, stagingPath, toolHome } from "#core/store/paths.ts";
import { type Need, needsOf } from "./depends.ts";
import type { Acquired, Placement, Staged } from "./model.ts";
import { wrapsNamespaces } from "./namespaces.ts";
import { candidates } from "./select.ts";

export interface AcquireOptions {
  /** The scope's root, which a relative location in its manifest is relative to. */
  base: string;
  /**
   * Registries to open. Absent means every one the manifest asks for; a job
   * names its own, because the others are another account's to authenticate.
   */
  aliases?: readonly string[];
  onStep?: (message: string) => void;
  credentials?: Readonly<Record<string, Credential>>;
  signal?: AbortSignal;
  onBytes?: (count: number) => void;
  /** Each artifact's bytes as they are downloaded, so progress can name what is arriving. */
  onDownload?: (artifact: Artifact, bytes: number) => void;
  /** Names to read beyond what the manifest asks for, by alias: what your own folders published. */
  also?: ReadonlyMap<string, readonly string[]>;
  /**
   * Holds each request to the lock, except the rows `moving` names. Absent asks for latest.
   * `held` takes nothing the lock does not hold, as a removal must not install.
   */
  locked?: Locked;
  /** Exact versions to ask for beyond the manifest, by alias: what its artifacts depend on. */
  needs?: ReadonlyMap<string, readonly Want[]>;
}

interface Locked {
  lock: Lock;
  moving: ReadonlySet<string>;
  held?: boolean;
}

/**
 * Undefined means the registry was never asked for. `all` means a whole
 * registry or namespace, and the named wants still pin what they name.
 */
export function wanted(manifest: Manifest, alias: string): Request | undefined {
  // Keyed by address, so a pin stays on the artifact it was written on.
  const byAddress = new Map<string, Want>();
  let asked = false;
  let all = false;
  for (const ref of manifest.artifacts) {
    if (ref.registry !== alias) continue;
    asked = true;
    if (ref.name === undefined) {
      all = true;
      continue;
    }
    const address = formatAddress(ref);
    const version = ref.version ?? byAddress.get(address)?.version;
    byAddress.set(address, {
      name: ref.name,
      ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }),
      ...(ref.kind === undefined ? {} : { kind: ref.kind }),
      ...(version === undefined ? {} : { version }),
    });
  }
  if (!asked) return undefined;
  const want = [...byAddress.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => item);
  return { want, all };
}

/**
 * Locked rows are asked for at their locked version unless moved or pinned, so later publishes wait
 * for `update`; a whole reference reaching no row is new and asks for everything, unless `held`.
 */
function lockedRequest(
  manifest: Manifest,
  alias: string,
  { lock, moving, held = false }: Locked,
  view: LockView,
): Request | undefined {
  const request = wanted(manifest, alias);
  if (request === undefined) return undefined;
  const pins = request.want.filter((want) => want.version !== undefined);
  const asked = new Map<string, Want>();
  const named = new Set<string>();
  let all = false;
  for (const ref of manifest.artifacts) {
    if (ref.registry !== alias) continue;
    const rows = view.reached(ref);
    for (const name of rows) named.add(name);
    if (ref.name === undefined && !held && rows.every((name) => moving.has(name))) {
      all = true;
      continue;
    }
    for (const name of rows) {
      const row = lock.artifacts[name] as LockArtifact;
      const pinned = pins.some((want) => covers(want, row));
      const free = moving.has(name) || pinned || row.version === undefined;
      asked.set(name, {
        name: row.name,
        namespace: row.namespace,
        kind: row.kind,
        ...(free ? {} : { version: row.version }),
      });
    }
  }
  // A dependency is held at the version its dependents needed; the closure moves it when they do.
  for (const [name, row] of view.rows(alias)) {
    if (row.neededBy === undefined || named.has(name)) continue;
    asked.set(name, {
      name: row.name,
      namespace: row.namespace,
      kind: row.kind,
      ...(row.version === undefined ? {} : { version: row.version }),
    });
  }
  return { want: [...request.want, ...asked.values()], all };
}

/** A lock as plans read it: rows grouped by registry once, each registry's view built once. */
export interface LockView {
  /** The rows recorded from one registry, by installed name. */
  rows(alias: string): readonly (readonly [string, LockArtifact])[];
  /** The registry as the lock last resolved it, or undefined when the lock has none. */
  source(alias: string): Acquired | undefined;
  /** The locked rows a reference reaches, by installed name. */
  reached(ref: Ref): string[];
}

export function lockView(lock: Lock): LockView {
  const byRegistry = new Map<string, [string, LockArtifact][]>();
  for (const [name, row] of Object.entries(lock.artifacts)) {
    const rows = byRegistry.get(row.registry) ?? [];
    rows.push([name, row]);
    byRegistry.set(row.registry, rows);
  }
  const rows = (alias: string) => byRegistry.get(alias) ?? [];
  const built = new Map<string, { source: Acquired; at: Map<string, string> } | undefined>();
  const registry = (alias: string) => {
    if (!built.has(alias)) {
      const source = fromRows(lock, alias, rows(alias));
      const at = new Map<string, string>();
      for (const [name, row] of rows(alias))
        if (row.address !== undefined) at.set(row.address, name);
      built.set(alias, source === undefined ? undefined : { source, at });
    }
    return built.get(alias);
  };
  return {
    rows,
    source: (alias) => registry(alias)?.source,
    reached(ref) {
      const found = registry(ref.registry);
      if (found === undefined) return [];
      return candidates(ref, found.source).flatMap((entry) => found.at.get(entry.path) ?? []);
    },
  };
}

/** The locked rows a reference reaches, by installed name. */
export function reached(lock: Lock, ref: Ref): string[] {
  return lockView(lock).reached(ref);
}

function fromRows(
  lock: Lock,
  alias: string,
  rows: readonly (readonly [string, LockArtifact])[],
): Acquired | undefined {
  const source = lock.registries[alias];
  if (source === undefined) return undefined;
  const entries: Entry[] = [];
  const placements = new Map<string, Placement>();
  const needs = new Map<string, Need[]>();
  for (const [, row] of rows) {
    if (row.namespace === undefined || row.version === undefined) {
      continue;
    }
    const need = { namespace: row.namespace, kind: row.kind, name: row.name, version: row.version };
    for (const by of row.neededBy ?? []) needs.set(by, [...(needs.get(by) ?? []), need]);
  }
  for (const [name, row] of rows) {
    if (row.id === undefined || row.address === undefined) continue;
    entries.push({
      name: sanitizeName(row.name),
      kind: row.kind,
      path: row.address,
      group: row.namespace,
      description: undefined,
      engine: undefined,
      from: { file: source.adapter, pointer: row.id },
    });
    placements.set(row.address, {
      id: row.id,
      name: row.name,
      contentId: row.content,
      version: row.version,
      needs: needs.get(name),
    });
  }
  return {
    alias,
    origin: {
      adapter: source.adapter,
      location: source.location,
      declared: source.location,
      key: source.key,
      config: source.config,
      revision: source.revision,
    },
    placements,
    catalog: { root: source.adapter, layouts: [], entries, warnings: [] },
    content: () => Promise.reject(new Error(`Registry ${quoted(alias)} was not opened.`)),
    close: async () => {},
  };
}

/**
 * Whether the lock alone answers every reference the manifest makes to this registry where it
 * still declares it. With `held`, a reference whose every match is excluded asks for nothing.
 */
export function answers(manifest: Manifest, source: Acquired, held = false): boolean {
  const declared = manifest.registries[source.alias];
  if (
    declared === undefined ||
    declared.location !== source.origin.declared ||
    (declared.adapter !== undefined && declared.adapter !== source.origin.adapter) ||
    JSON.stringify(declared.config) !== JSON.stringify(source.origin.config)
  ) {
    return false;
  }
  return manifest.artifacts
    .filter((ref) => ref.registry === source.alias)
    .every((ref) => {
      const found = candidates(ref, source);
      if (found.length === 0) return held && ref.exclude !== undefined;
      return (
        ref.version === undefined ||
        found.every((entry) => source.placements.get(entry.path)?.version === ref.version)
      );
    });
}

/** A name your folder published may not exist yet, so the catalog is listed rather than asked by name. */
function withAlso(
  request: Request | undefined,
  names: readonly string[] | undefined,
): Request | undefined {
  if (names === undefined || names.length === 0) return request;
  return { want: request?.want ?? [], all: true };
}

/** A need's version replaces the one the lock held its dependency at. */
function withNeeds(
  request: Request | undefined,
  needs: readonly Want[] | undefined,
): Request | undefined {
  if (request === undefined || needs === undefined) return request;
  const same = (a: Want, b: Want) =>
    a.name === b.name && a.namespace === b.namespace && a.kind === b.kind;
  const held = request.want.filter((want) => !needs.some((need) => same(want, need)));
  return { ...request, want: [...held, ...needs] };
}

export interface Request {
  want: Want[];
  all: boolean;
}

/** A refused read says how to sign in to this registry, unless its adapter already did. */
async function withSignInHint(error: unknown, alias: string): Promise<unknown> {
  if (!isAdapterError(error) || !isAuthFailure(error.failure) || error.hint !== undefined) {
    return error;
  }
  const own = await loadAdapter(error.adapter).then(
    (adapter) => adapter.credentialsHint,
    () => undefined,
  );
  return new AdapterError(error.adapter, error.failure, error.message, {
    artifact: error.artifact,
    retryAfterMs: error.retryAfterMs,
    problem: adapterProblem(error),
    cause: error.cause,
    hint: own ?? `Run \`aireg auth login ${alias}\`, or in CI set \`${tokenVariable(alias)}\`.`,
  });
}

async function acquireOne(
  alias: string,
  declared: RegistrySource,
  request: Request,
  options: AcquireOptions,
): Promise<Acquired> {
  const location = expandLocation(declared.location, options.base);
  const open = await connectSource(
    {
      alias,
      location,
      declared: declared.location,
      adapter: declared.adapter,
      config: declared.config,
    },
    { credential: options.credentials?.[alias], signal: options.signal, onBytes: options.onBytes },
  ).catch(async (error: unknown) => {
    throw await withSignInHint(error, alias);
  });

  let listing: Awaited<ReturnType<typeof resolveArtifacts>>;
  try {
    listing = await resolveArtifacts(open, request.want, { all: request.all });
  } catch (error) {
    await open.handle.close();
    throw await withSignInHint(error, alias);
  }
  const at =
    listing.sourceRevision === undefined ? "" : ` at ${abbreviate(listing.sourceRevision)}`;
  options.onStep?.(`${alias}: ${location}${at}`);
  for (const { path, artifact } of listing.listed) {
    if (artifact.yanked === undefined) continue;
    const { namespace, name, version } = artifact.envelope.metadata;
    // A new pin is the caller's to refuse, so only one the lock holds is a warning.
    const lock = options.locked?.lock;
    const held = lock === undefined ? undefined : heldAs(lock, alias, path, version);
    if (lock !== undefined && held === undefined) continue;
    // Named as the lockfile and every other line name it.
    const shown = held ?? [namespace, name].filter(Boolean).join("/");
    listing.catalog.warnings.push(
      `${sanitizeText(shown)} ${version} is yanked${because(artifact.yanked)}; the lockfile holds it, so it stays installed.`,
    );
  }

  const placements = new Map<string, Placement>();
  for (const { path, artifact } of listing.listed) {
    const { needs, unusable } = needsOf(artifact.envelope);
    const { name, version } = artifact.envelope.metadata;
    for (const to of unusable) {
      listing.catalog.warnings.push(
        `"${name}" depends on "${sanitizeText(to)}", which is not a namespace/kind/name@version aireg installs; it was left out.`,
      );
    }
    placements.set(path, {
      id: artifact.id,
      name,
      contentId: contentDigest(artifact.envelope),
      version,
      needs,
      ...(artifact.yanked === undefined ? {} : { yanked: artifact.yanked }),
    });
  }

  // One placement per artifact however often it is asked for, so a command that
  // stages and then digests the same content pays for it once.
  const placed = new Map<string, Promise<Staged>>();

  return {
    alias,
    origin: {
      adapter: open.adapter.id,
      location,
      declared: declared.location,
      key: open.key,
      config: declared.config,
      revision: listing.sourceRevision,
    },
    placements,
    catalog: listing.catalog,
    namespacePlugins: wrapsNamespaces(open.adapter),
    content: (entryPath) => {
      const already = placed.get(entryPath);
      if (already !== undefined) return already;

      const item = listing.listed.find((candidate) => candidate.path === entryPath);
      if (item === undefined) {
        return Promise.reject<Staged>(
          new AiregError(`${alias} publishes nothing at ${entryPath}.`, {
            code: ErrorCode.NotFound,
          }),
        );
      }
      ensureHome();
      const pending = materialize(open.adapter.id, open.handle, item.artifact, {
        into: (content) => stagingPath(content),
        boundary: toolHome(),
        onRead: (bytes) => {
          options.onBytes?.(bytes);
          options.onDownload?.(item.artifact, bytes);
        },
      });
      placed.set(entryPath, pending);
      return pending;
    },
    close: () => open.handle.close(),
  };
}

function because(yanked: { reason: string | undefined }): string {
  return yanked.reason === undefined ? "" : ` (${sanitizeText(yanked.reason)})`;
}

/** The lock row that installs this entry at this version already, which a yank does not undo. */
function heldAs(
  lock: Lock,
  alias: string,
  path: string,
  version: string | undefined,
): string | undefined {
  return Object.entries(lock.artifacts).find(
    ([, row]) => row.registry === alias && row.address === path && row.version === version,
  )?.[0];
}

function holds(lock: Lock, alias: string, path: string, version: string | undefined): boolean {
  return heldAs(lock, alias, path, version) !== undefined;
}

/** Yanked versions this run would install that the lock does not already hold. */
export function newlyYanked(acquired: readonly Acquired[], lock: Lock): string[] {
  return acquired.flatMap((source) =>
    [...source.placements].flatMap(([path, { name, version, yanked }]) =>
      yanked === undefined || holds(lock, source.alias, path, version)
        ? []
        : [`"${sanitizeText(name)}" ${version} is yanked${because(yanked)}`],
    ),
  );
}

/**
 * The impure half of the pipeline: everything after this point is a pure
 * function of the values it returns.
 */
export async function acquire(manifest: Manifest, options: AcquireOptions): Promise<Acquired[]> {
  // A registry the manifest names no artifact from is never opened or downloaded.
  const owned = options.aliases === undefined ? undefined : new Set(options.aliases);
  const locked = options.locked;
  const view = locked === undefined ? undefined : lockView(locked.lock);
  const asked = Object.entries(manifest.registries)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .filter(([alias]) => owned === undefined || owned.has(alias))
    .map(([alias, declared]) => ({
      alias,
      declared,
      request: withNeeds(
        withAlso(
          locked === undefined || view === undefined
            ? wanted(manifest, alias)
            : lockedRequest(manifest, alias, locked, view),
          options.also?.get(alias),
        ),
        options.needs?.get(alias),
      ),
    }))
    .filter((entry): entry is typeof entry & { request: Request } => entry.request !== undefined);

  const settled = await Promise.allSettled(
    asked.map(({ alias, declared, request }) => acquireOne(alias, declared, request, options)),
  );
  const failed = settled.find((result) => result.status === "rejected");
  const opened = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (failed === undefined) return opened;
  // One registry failing leaves no other one open behind it.
  await Promise.allSettled(opened.map((source) => source.close()));
  throw failed.reason;
}
