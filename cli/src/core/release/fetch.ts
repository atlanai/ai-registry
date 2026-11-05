import { AiregError, ErrorCode } from "#core/errors.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { NAME, releaseBinary } from "#core/product.ts";
import { VERSION } from "#core/version.ts";
import {
  artifactNamed,
  MAX_MANIFEST_BYTES,
  type ReleaseManifest,
  verifyManifest,
} from "./manifest.ts";
import { artifactUrl, manifestUrl } from "./origin.ts";
import { requireReleasePlatform } from "./platform.ts";
import type { ReleaseStamp } from "./stamp.ts";

export interface ManifestPlan {
  readonly kind: "manifest";
  readonly url: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

export async function fetchManifest(
  stamp: ReleaseStamp,
  $fetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReleaseManifest> {
  const url = manifestUrl(stamp.origin, stamp.channel);
  if (url === undefined)
    throw new AiregError(`No release manifest URL for the ${stamp.channel} channel.`, {
      code: ErrorCode.Unavailable,
    });
  const body = await fetchOriginBytes(url, MAX_MANIFEST_BYTES, $fetch, signal);
  const manifest = verifyManifest(new TextDecoder().decode(body), stamp.keys, stamp.channel);
  if (manifest.adapter !== undefined)
    throw new AiregError(`The release server offered adapter ${manifest.adapter}, not ${NAME}.`, {
      code: ErrorCode.Integrity,
    });
  return manifest;
}

export function manifestPlan(stamp: ReleaseStamp, manifest: ReleaseManifest): ManifestPlan {
  const name = releaseBinary(requireReleasePlatform());
  const entry = artifactNamed(manifest, name);
  if (entry === undefined)
    throw new AiregError(`Release ${manifest.version} has no ${name}.`, {
      code: ErrorCode.Unavailable,
    });
  const url = artifactUrl(stamp.origin, manifest.version, name);
  if (url === undefined)
    throw new AiregError(`Release ${manifest.version} has no download URL.`, {
      code: ErrorCode.Unavailable,
    });
  return { kind: "manifest", url, name, sha256: entry.sha256, size: entry.size };
}

export async function downloadArtifact(
  plan: ManifestPlan,
  $fetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await fetchOriginBytes(plan.url, plan.size, $fetch, signal);
  if (bytes.byteLength !== plan.size)
    throw new AiregError(`The download of ${plan.name} is the wrong size.`, {
      code: ErrorCode.Integrity,
    });
  if (sha256Hex(bytes) !== plan.sha256)
    throw new AiregError(`The download of ${plan.name} failed its checksum.`, {
      code: ErrorCode.Integrity,
    });
  return bytes;
}

/**
 * A redirect is refused rather than followed: following one is exactly how a
 * derived URL turns back into an arbitrary-URL fetch.
 */
export async function fetchOriginBytes(
  url: string,
  limit: number,
  $fetch: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const response = await $fetch(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": `${NAME}/${VERSION}` },
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (!response.ok || (Number.isFinite(declared) && declared > limit)) {
    await response.body?.cancel().catch(() => {});
    if (!response.ok)
      throw new AiregError(`The release server answered ${response.status} for ${url}.`, {
        code: ErrorCode.Unavailable,
      });
    throw new AiregError(`${url} is over its limit.`, { code: ErrorCode.Integrity });
  }
  if (response.body === null) {
    signal?.throwIfAborted();
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  // One buffer sized by the declared length when there is one, so a release binary
  // is held once rather than as chunks and then again joined.
  let bytes = new Uint8Array(Number.isFinite(declared) && declared >= 0 ? declared : 64 * 1024);
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (size + value.byteLength > limit)
        throw new AiregError(`${url} is over its limit.`, { code: ErrorCode.Integrity });
      if (size + value.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(limit, Math.max(size + value.byteLength, bytes.byteLength * 2)),
        );
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return size === bytes.byteLength ? bytes : bytes.slice(0, size);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
