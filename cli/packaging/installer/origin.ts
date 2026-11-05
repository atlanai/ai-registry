import {
  normalizeOrigin,
  artifactBaseUrl as releaseArtifactBaseUrl,
  artifactsUrl as releaseArtifactsUrl,
} from "#core/release/origin.ts";

/** Nothing that could close a quote or start a command. */
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const PATH = /^(?:\/[A-Za-z0-9._-]+)*$/;

/** Normalized and safe to interpolate into the script, or undefined. */
export function installerOrigin(origin: string): string | undefined {
  const normalized = normalizeOrigin(origin);
  if (normalized === undefined) return undefined;
  const url = new URL(normalized);
  // A bare host such as https://aireg.sh parses with pathname "/", which PATH alone rejects.
  const path = url.pathname === "/" ? "" : url.pathname;
  if (!HOST.test(url.host) || !PATH.test(path)) return undefined;
  return normalized;
}

/** One release's artifact directory, or undefined for an origin `installerOrigin` refuses. */
export function artifactBaseUrl(origin: string, version: string): string | undefined {
  const safe = installerOrigin(origin);
  return safe === undefined ? undefined : releaseArtifactBaseUrl(safe, version);
}

/** The folder every release sits in, or undefined for an origin `installerOrigin` refuses. */
export function artifactsUrl(origin: string): string | undefined {
  const safe = installerOrigin(origin);
  return safe === undefined ? undefined : releaseArtifactsUrl(safe);
}
