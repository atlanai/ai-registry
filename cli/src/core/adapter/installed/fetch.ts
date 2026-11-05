import { AiregError, ErrorCode } from "#core/errors.ts";
import { RELEASE_ADAPTER_FILE } from "#core/product.ts";
import { downloadArtifact, fetchOriginBytes, type ManifestPlan } from "#core/release/fetch.ts";
import {
  artifactNamed,
  MAX_MANIFEST_BYTES,
  type ReleaseManifest,
  verifyManifest,
} from "#core/release/manifest.ts";
import {
  adapterArtifactUrl,
  adapterManifestUrl,
  adapterVersionManifestUrl,
} from "#core/release/origin.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import type { AdapterWant } from "./want.ts";

export interface AdapterRelease {
  readonly id: string;
  readonly version: string;
  readonly plan: ManifestPlan;
}

/**
 * An adapter manifest's `minimum_version` is a floor on the adapter's own line,
 * not the CLI's; `protocol` against `ADAPTER_PROTOCOL` is what gates the client.
 */
export async function resolveAdapter(
  want: AdapterWant,
  stamp: ReleaseStamp,
  $fetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AdapterRelease> {
  const url = manifestLocation(stamp, want);
  const body = await fetchOriginBytes(url, MAX_MANIFEST_BYTES, $fetch, signal);
  const expectedChannel = want.version === undefined ? stamp.channel : undefined;
  const manifest = verifyManifest(new TextDecoder().decode(body), stamp.keys, expectedChannel);
  assertReleaseOf(want.id, manifest);
  if (want.version !== undefined && manifest.version !== want.version) {
    throw new AiregError(
      `The release server offered adapter ${want.id} ${manifest.version}, not ${want.version}.`,
      { code: ErrorCode.Integrity },
    );
  }
  return { id: want.id, version: manifest.version, plan: adapterPlan(stamp, want.id, manifest) };
}

function manifestLocation(stamp: ReleaseStamp, want: AdapterWant): string {
  const url =
    want.version === undefined
      ? adapterManifestUrl(stamp.origin, want.id, stamp.channel)
      : adapterVersionManifestUrl(stamp.origin, want.id, want.version);
  if (url === undefined)
    throw new AiregError(`The release server has no download for adapter ${want.id}.`, {
      code: ErrorCode.Unavailable,
    });
  return url;
}

/** Released before manifests named their adapter; every other adapter's release must name it. */
const UNNAMED_RELEASES = ["atlan"];

function assertReleaseOf(id: string, manifest: ReleaseManifest): void {
  const named = manifest.adapter;
  if (named === id || (named === undefined && UNNAMED_RELEASES.includes(id))) return;
  const offered = named === undefined ? "a release that names no adapter" : `adapter ${named}`;
  throw new AiregError(`The release server offered ${offered}, not ${id}.`, {
    code: ErrorCode.Integrity,
  });
}

function adapterPlan(stamp: ReleaseStamp, id: string, manifest: ReleaseManifest): ManifestPlan {
  const entry = artifactNamed(manifest, RELEASE_ADAPTER_FILE);
  if (entry === undefined) {
    throw new AiregError(
      `Adapter ${id} ${manifest.version} has no ${RELEASE_ADAPTER_FILE} on the release server.`,
      { code: ErrorCode.Unavailable },
    );
  }
  const url = adapterArtifactUrl(stamp.origin, id, manifest.version, RELEASE_ADAPTER_FILE);
  if (url === undefined) {
    throw new AiregError(
      `Adapter ${id} ${manifest.version} has no download on the release server.`,
      { code: ErrorCode.Unavailable },
    );
  }
  return {
    kind: "manifest",
    url,
    name: RELEASE_ADAPTER_FILE,
    sha256: entry.sha256,
    size: entry.size,
  };
}

export async function downloadAdapter(
  release: AdapterRelease,
  $fetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return downloadArtifact(release.plan, $fetch, signal);
}
