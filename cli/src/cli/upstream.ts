import { credentialFor } from "#accounts/credentials.ts";
import { contentDigest, type ResolveOptions, type Want } from "#adapter/index.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { connectSource, resolveArtifacts } from "#core/adapter/source.ts";
import type { Entry } from "#core/catalog/model.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import { type Request, recordedAdapter, wanted } from "#core/plan/acquire.ts";
import { olderThan } from "#core/semver.ts";

/** What one source publishes right now, or why it could not be asked. */
export interface Head {
  /**
   * Keyed by the address: an artifact's id carries its version, so it never
   * matches across the very bump `aireg outdated` exists to report.
   */
  byAddress: Map<string, Upstream>;
  /** The newest version in the manifest's range, by address, when asked for: each artifact given one. */
  inRange: Map<string, Upstream>;
  entries: readonly Entry[];
  why: string | undefined;
}

export interface Upstream {
  contentId: string | undefined;
  version: string | undefined;
  name: string;
  namespace: string | undefined;
}

/**
 * Include locked names the manifest does not ask for, so a withdrawal stays
 * visible. Pins are dropped: asking at the pinned version would only echo it back.
 */
function asked(request: Request | undefined, lock: Lock, alias: string): [Want[], ResolveOptions] {
  if (request === undefined || request.all || request.want.length === 0) return [[], {}];
  const locked = Object.values(lock.artifacts)
    .filter((artifact) => artifact.registry === alias)
    .map((artifact) => artifact.name);
  const names = new Set([...request.want.map((item) => item.name), ...locked]);
  return [[...names].map((name) => ({ name })), {}];
}

/**
 * What a registry publishes now, at the latest version of everything the scope takes from it, and
 * with `withinRanges` also at the newest version in each range the manifest gives.
 */
export async function head(
  alias: string,
  manifest: Manifest,
  lock: Lock,
  base: string,
  withinRanges = false,
): Promise<Head> {
  const declared = manifest.registries[alias];
  if (declared === undefined) {
    return {
      byAddress: new Map(),
      inRange: new Map(),
      entries: [],
      why: "it is no longer declared",
    };
  }

  const location = expandLocation(declared.location, base);
  try {
    const credential = await credentialFor(alias, declared, location);
    const open = await connectSource(
      { alias, location, adapter: recordedAdapter(declared, lock, alias), config: declared.config },
      credential === undefined ? {} : { credential },
    );
    try {
      const request = wanted(manifest, alias);
      const [want, options] = asked(request, lock, alias);
      const listing = await resolveArtifacts(open, want, options);
      // Asked again in their ranges, which is where `aireg update` moves them.
      const ranged = withinRanges
        ? (request?.want ?? []).filter((item) => item.range !== undefined)
        : [];
      const within = ranged.length === 0 ? [] : (await resolveArtifacts(open, ranged)).listed;
      return {
        byAddress: upstreams(listing.listed),
        inRange: upstreams(within),
        entries: listing.catalog.entries,
        why: undefined,
      };
    } finally {
      await open.handle.close();
    }
  } catch (error) {
    return { byAddress: new Map(), inRange: new Map(), entries: [], why: (error as Error).message };
  }
}

function upstreams(listed: Awaited<ReturnType<typeof resolveArtifacts>>["listed"]) {
  return new Map<string, Upstream>(
    listed.map((item) => [
      item.path,
      {
        contentId: contentDigest(item.artifact.envelope),
        version: item.artifact.version ?? item.artifact.envelope.metadata.version,
        name: item.artifact.envelope.metadata.name,
        namespace: item.artifact.envelope.metadata.namespace,
      },
    ]),
  );
}

/**
 * A source that attests content answers without a download; one that does not can only be
 * compared on the version it publishes. A version that a yank moved below what is installed is
 * older, so it is not offered as an update.
 */
export function newer(upstream: Upstream, entry: LockArtifact): boolean {
  return (
    !olderThan(upstream.version, entry.version) &&
    (upstream.contentId !== undefined && entry.content !== ""
      ? upstream.contentId !== entry.content
      : upstream.version !== entry.version)
  );
}
