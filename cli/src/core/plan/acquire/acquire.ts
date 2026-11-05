import { adapterProblem, isAuthFailure } from "#adapter/errors.ts";
import {
  AdapterError,
  type Artifact,
  type Credential,
  contentDigest,
  isAdapterError,
  type Want,
} from "#adapter/index.ts";
import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import { sanitizeText } from "#adapter/text.ts";
import { connectSource, resolveArtifacts } from "#core/adapter/connect.ts";
import { declaredLayout, loadAdapter } from "#core/adapter/load.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { materialize } from "#core/adapter/materialize.ts";
import { tokenVariable } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Lock } from "#core/lock.ts";
import type { Manifest, RegistrySource } from "#core/manifest/model.ts";
import { needsOf } from "#core/plan/depends.ts";
import type { Acquired, Placement, Staged } from "#core/plan/model.ts";
import { wrapsNamespaces } from "#core/plan/namespaces.ts";
import { ensureHome, stagingPath, toolHome } from "#core/store/paths.ts";
import { abbreviate } from "#core/term/printer.ts";
import { lockView } from "./lock-view.ts";
import { because, heldAs, leftOutOf, pluginOf, revisionOf, statusOf } from "./placement.ts";
import { type Locked, lockedRequest, type Request, wanted } from "./request.ts";

export interface AcquireOptions {
  /** Root that relative manifest locations resolve against. */
  base: string;
  /** Registries to open; absent means all. A job names its own, since others need another account. */
  aliases?: readonly string[];
  onStep?: (message: string) => void;
  credentials?: Readonly<Record<string, Credential>>;
  signal?: AbortSignal;
  onBytes?: (count: number) => void;
  onDownload?: (artifact: Artifact, bytes: number) => void;
  /** Extra names to read per alias: what your own folders published. */
  also?: ReadonlyMap<string, readonly string[]>;
  /**
   * Holds requests to the lock except rows in `moving`; absent asks for latest.
   * `held` takes nothing the lock lacks, as a removal must not install.
   */
  locked?: Locked;
  /** Exact versions to ask for per alias: what installed artifacts depend on. */
  needs?: ReadonlyMap<string, readonly Want[]>;
  /** The lockfile whose adapter keeps reading a registry the manifest names none for. */
  recorded?: Lock;
}

/** Keeps the locked adapter when the manifest names none, so a new adapter cannot take over. */
export function recordedAdapter(
  declared: RegistrySource,
  lock: Lock | undefined,
  alias: string,
): string | undefined {
  if (declared.adapter !== undefined) return declared.adapter;
  const held = lock?.registries[alias];
  return held !== undefined && held.location === declared.location ? held.adapter : undefined;
}

/** The impure half of the pipeline; everything after it is pure. */
export async function acquire(manifest: Manifest, options: AcquireOptions): Promise<Acquired[]> {
  const owned = options.aliases === undefined ? undefined : new Set(options.aliases);
  const locked = options.locked;
  const view = locked === undefined ? undefined : lockView(locked.lock);
  // A registry the manifest names no artifact from is never opened or downloaded.
  const asked = Object.entries(manifest.registries)
    .sort(([left], [right]) => Number(left > right) - Number(left < right))
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

/** A name your folder published may not exist yet, so list the whole catalog. */
function withAlso(
  request: Request | undefined,
  names: readonly string[] | undefined,
): Request | undefined {
  if (names === undefined || names.length === 0) return request;
  return { want: request?.want ?? [], all: true };
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
      adapter: recordedAdapter(declared, options.recorded ?? options.locked?.lock, alias),
      config: declared.config,
      layout: declaredLayout(declared.config),
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
    const shown = held ?? [namespace, name].filter(Boolean).join("/");
    listing.catalog.warnings.push(
      `${sanitizeText(shown)} ${version} is yanked${because(artifact.yanked)}; the lockfile holds it, so it stays installed.`,
    );
  }

  const placements = new Map<string, Placement>();
  for (const { path, artifact, leftOut } of listing.listed) {
    const { needs, unusable } = needsOf(artifact.envelope);
    const { name } = artifact.envelope.metadata;
    const version = artifact.version ?? artifact.envelope.metadata.version;
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
      ...statusOf(artifact),
      ...(isReadOnlyLayout(listing.layout) ? pluginOf(artifact) : {}),
      ...revisionOf(artifact),
      ...leftOutOf(artifact, leftOut),
    });
  }

  // Memoized so staging then digesting the same content downloads it once.
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
      ...(listing.layout === undefined ? {} : { layout: listing.layout }),
    },
    placements,
    catalog: listing.catalog,
    namespacePlugins: wrapsNamespaces(open.adapter),
    whole: request.all,
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
