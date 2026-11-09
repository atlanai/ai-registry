import { isVersion } from "../spec/ref.ts";

export const REGISTRY_DOCUMENT = "registry.json";
export const INDEX_DOCUMENT = "index.json";
export const VERSIONS_DOCUMENT = "versions.json";
export const ARTIFACTS_DIR = "artifacts";
/** Reserved in a version folder: never authored content, digested or copied to a target. */
export const ENVELOPE = "artifact.json";

/** File spec section 2.1. */
export const MAX_SEGMENT = 64;

const SEGMENT = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
/** The file spec's kind grammar; `isKindSegment` tests it. */
export const KIND_SEGMENT = /^[a-z][a-z0-9_]{0,31}$/;

// Windows opens a device at these names, in any case and with any extension.
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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

/** A lowercase letter, then lowercase letters, digits or underscores, at most 32 characters. */
export function isKindSegment(value: string): boolean {
  return KIND_SEGMENT.test(value);
}

/** Relative to the registry root. */
export function artifactDir(namespace: string, kind: string, name: string): string {
  return `${ARTIFACTS_DIR}/${namespace}/${kind}/${name}`;
}

export function versionsPath(namespace: string, kind: string, name: string): string {
  return `${artifactDir(namespace, kind, name)}/${VERSIONS_DOCUMENT}`;
}

export function versionDir(namespace: string, kind: string, name: string, version: string): string {
  return `${artifactDir(namespace, kind, name)}/${version}`;
}

export interface ArtifactPlace {
  /** The path above `artifacts`; empty at the registry root. */
  root: string;
  namespace: string;
  kind: string;
  name: string;
  version: string | undefined;
}

/** The innermost `artifacts/<namespace>/<kind>/<name>` in a path. */
export function artifactAt(path: string): ArtifactPlace | undefined {
  const parts = path.split("/").filter(Boolean);
  for (let at = parts.length - 4; at >= 0; at -= 1) {
    const [top, namespace = "", kind = "", name = "", version] = parts.slice(at);
    if (top !== ARTIFACTS_DIR || !isNamespace(namespace)) continue;
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
