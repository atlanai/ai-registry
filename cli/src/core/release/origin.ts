import { ADAPTER_ID } from "#adapter/index.ts";
import { formatVersion, parseVersion } from "#adapter/semver.ts";
import { stripTrailing } from "#adapter/text.ts";

/**
 * Closed set: an unknown channel has no URL, so a caller rejects the metadata
 * rather than building a path out of an unvetted string.
 */
const CHANNELS = ["stable", "canary"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Only `stable` is published; AIREG_RELEASE_CHANNEL can name another channel. */
export const DEFAULT_CHANNEL: Channel = "stable";

/** One path segment, so a derived URL can never climb out of its directory. */
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

/** https only, no credentials, query or fragment; a trailing slash is not significant. */
export function normalizeOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return stripTrailing(`${url.origin}${url.pathname}`, "/");
}

/** The one manifest URL a build stamped for `origin` will accept for `channel`. */
export function manifestUrl(origin: string, channel: string): string | undefined {
  const base = normalizeOrigin(origin);
  if (base === undefined || !isChannel(channel)) return undefined;
  return `${base}/channels/${channel}/manifest.json`;
}

/** The directory every release's artifacts sit under, one `v<version>` folder each. */
export function artifactsUrl(origin: string): string | undefined {
  const base = normalizeOrigin(origin);
  return base === undefined ? undefined : `${base}/artifacts`;
}

/** Undefined unless `version` is canonical, since it becomes a path segment. */
export function artifactBaseUrl(origin: string, version: string): string | undefined {
  const root = artifactsUrl(origin);
  const parsed = parseVersion(version);
  if (root === undefined || parsed === undefined || formatVersion(parsed) !== version) {
    return undefined;
  }
  return `${root}/v${version}`;
}

/**
 * Derived from (origin, version, filename) and never read from the manifest's
 * `url`, so even a compromised signing key cannot redirect a fetch.
 */
export function artifactUrl(origin: string, version: string, filename: string): string | undefined {
  const base = artifactBaseUrl(origin, version);
  if (base === undefined || !FILENAME.test(filename)) return undefined;
  return `${base}/${filename}`;
}

export function isAdapterId(value: string): boolean {
  return ADAPTER_ID.test(value);
}

export function adapterManifestUrl(
  origin: string,
  id: string,
  channel: string,
): string | undefined {
  const base = adapterOrigin(origin, id);
  return base === undefined ? undefined : manifestUrl(base, channel);
}

/** `{origin}/adapters/{id}`: one host and keyring, independent adapter versions. */
function adapterOrigin(origin: string, id: string): string | undefined {
  const base = normalizeOrigin(origin);
  if (base === undefined || !isAdapterId(id)) return undefined;
  return `${base}/adapters/${id}`;
}

/**
 * Per-version signed document, used when the caller pins `@1.4.0` rather than
 * the channel head. Lives next to the artifact so the directory is the unit.
 */
export function adapterVersionManifestUrl(
  origin: string,
  id: string,
  version: string,
): string | undefined {
  const base = adapterOrigin(origin, id);
  if (base === undefined) return undefined;
  const dir = artifactBaseUrl(base, version);
  return dir === undefined ? undefined : `${dir}/manifest.json`;
}

export function adapterArtifactUrl(
  origin: string,
  id: string,
  version: string,
  filename: string,
): string | undefined {
  const base = adapterOrigin(origin, id);
  return base === undefined ? undefined : artifactUrl(base, version, filename);
}
