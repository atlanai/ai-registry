import { isVersion } from "../spec/ref.ts";

// The file spec's paths and names, shared by the reader, the writer and every
// command that names a registry document.

/** A root's discovery document. */
export const REGISTRY_DOCUMENT = "registry.json";
/** A root's list of every artifact at its latest version. */
export const INDEX_DOCUMENT = "index.json";
/** An artifact's list of its versions, beside its version folders. */
export const VERSIONS_DOCUMENT = "versions.json";
/**
 * The spec reserves this name in a version directory, so it can never be
 * authored content: it stays out of digests and out of any copy a target loads.
 */
export const ENVELOPE = "artifact.json";

/** The longest namespace or name segment section 2.1 allows. */
export const MAX_SEGMENT = 64;

/** Section 2.1. Segments are case-sensitive and a version may not be `latest`. */
const SEGMENT = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const KIND_SEGMENT = /^[a-z][a-z0-9_]{0,31}$/;

/** Windows opens a device, not a folder, at these names, in any case and with any extension. */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export { isVersion };

/** Section 2.1: no path segment may be one, or the registry cannot be checked out on Windows. */
export function isDeviceName(value: string): boolean {
  return DEVICE.test(value);
}

/** Section 2.1: lowercase letters, digits and inner hyphens, at most 64 characters. */
export function isNamespace(value: string): boolean {
  return SEGMENT.test(value);
}

/** Section 2.1: the same grammar as a namespace. */
export function isArtifactName(value: string): boolean {
  return SEGMENT.test(value);
}

/** A kind as a path segment: a lowercase letter, then letters, digits or underscores. */
export function isKindSegment(value: string): boolean {
  return KIND_SEGMENT.test(value);
}

/** Where an artifact's `versions.json` is, relative to the root. */
export function versionsPath(namespace: string, kind: string, name: string): string {
  return `artifacts/${namespace}/${kind}/${name}/${VERSIONS_DOCUMENT}`;
}

/** Where one version's folder is, relative to the root. */
export function versionDir(namespace: string, kind: string, name: string, version: string): string {
  return `artifacts/${namespace}/${kind}/${name}/${version}`;
}

/** Where a path inside a registry points: an artifact folder, a version in it, or a file in that. */
export interface ArtifactPlace {
  /** The registry's folder, as the part of the path above `artifacts`; empty at its root. */
  root: string;
  namespace: string;
  kind: string;
  name: string;
  version: string | undefined;
}

/** The innermost `artifacts/<namespace>/<kind>/<name>` in a path, read as the file spec lays it out. */
export function artifactAt(path: string): ArtifactPlace | undefined {
  const parts = path.split("/").filter(Boolean);
  for (let at = parts.length - 4; at >= 0; at -= 1) {
    const [top, namespace = "", kind = "", name = "", version] = parts.slice(at);
    if (top !== "artifacts" || !isNamespace(namespace)) continue;
    if (!isKindSegment(kind) || !isArtifactName(name)) continue;
    // Beside the version folders an artifact holds only its versions document.
    const pinned = version !== undefined && version !== VERSIONS_DOCUMENT && isVersion(version);
    return {
      root: parts.slice(0, at).join("/"),
      namespace,
      kind,
      name,
      version: pinned ? version : undefined,
    };
  }
  return undefined;
}
