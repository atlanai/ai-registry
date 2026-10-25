import { formatVersion, gte, parseVersion } from "#adapter/semver.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type Fields, hasOnly } from "#core/fields.ts";
import { isSha256Hex } from "#core/fs/hash.ts";
import { NAME } from "#core/product.ts";
import {
  decodeBase64,
  KEY_ID,
  SIGNATURE_BYTES,
  type TrustedKeys,
  verifyEd25519,
} from "./keyring.ts";
import { type Channel, isAdapterId, isChannel } from "./origin.ts";

export const MANIFEST_SCHEMA = `${NAME}-manifest.v1`;
export const MAX_MANIFEST_BYTES = 1 << 20;

/**
 * A sanity bound on a signed number, not a security boundary: the download is
 * held to the exact `size` the manifest states.
 */
const MAX_ARTIFACT_BYTES = 192 * 1024 * 1024;
const MAX_ARTIFACTS = 8;
const MAX_SIGNATURES = 8;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Strict on the way in: an unknown field is refused, not ignored. */
const MANIFEST_KEYS = [
  "schema",
  "adapter",
  "channel",
  "version",
  "minimum_version",
  "published_at",
  "artifacts",
  "signatures",
];
/** `url` is published for people to download by hand; it is unsigned and never read. */
const ARTIFACT_KEYS = ["name", "sha256", "size", "url"];
const SIGNATURE_KEYS = ["algorithm", "key_id", "value"];

export interface ManifestArtifact {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ReleaseManifest {
  /** Absent for aireg's own releases. */
  readonly adapter?: string;
  readonly channel: Channel;
  readonly version: string;
  readonly minimumVersion: string | undefined;
  readonly publishedAt: string;
  readonly artifacts: readonly ManifestArtifact[];
}

interface ManifestSignature {
  readonly keyId: string;
  readonly value: Uint8Array;
}

/**
 * The exact bytes every manifest signature covers, rebuilt from the validated
 * fields so transport whitespace and key order cannot change them.
 */
export function canonicalPayload(manifest: ReleaseManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: MANIFEST_SCHEMA,
      // Omitted when absent, so releases signed before the field still verify.
      ...(manifest.adapter === undefined ? {} : { adapter: manifest.adapter }),
      channel: manifest.channel,
      version: manifest.version,
      minimum_version: manifest.minimumVersion ?? null,
      published_at: manifest.publishedAt,
      artifacts: manifest.artifacts.map((artifact) => ({
        name: artifact.name,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
    }),
  );
}

/** The manifest, or a thrown reason. `channel` is the one this build asked for. */
export function verifyManifest(raw: string, keys: TrustedKeys, channel?: Channel): ReleaseManifest {
  if (raw.length === 0 || raw.length > MAX_MANIFEST_BYTES) {
    throw new AiregError("The release manifest size is invalid.", { code: ErrorCode.Invalid });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiregError("The release manifest is not valid JSON.", { code: ErrorCode.Invalid });
  }
  if (!hasOnly(parsed, MANIFEST_KEYS))
    throw new AiregError("The release manifest has unexpected fields.", {
      code: ErrorCode.Invalid,
    });
  const manifest = parseManifestBody(parsed);
  if (manifest === undefined)
    throw new AiregError("The release manifest is incompatible with this aireg.", {
      code: ErrorCode.Invalid,
    });
  if (channel !== undefined && manifest.channel !== channel) {
    throw new AiregError(`The release manifest is for ${manifest.channel}, not ${channel}.`, {
      code: ErrorCode.Integrity,
    });
  }
  const signatures = parseSignatures(parsed.signatures);
  if (signatures === undefined)
    throw new AiregError("The release manifest signature is malformed.", {
      code: ErrorCode.Integrity,
    });
  verifySignatures(canonicalPayload(manifest), signatures, keys);
  return manifest;
}

export function artifactNamed(
  manifest: ReleaseManifest,
  name: string,
): ManifestArtifact | undefined {
  return manifest.artifacts.find((artifact) => artifact.name === name);
}

/**
 * One trusted signature is enough, but a bad signature from a trusted key is
 * fatal: that is a broken or substituted publisher, not an unknown one.
 */
function verifySignatures(
  payload: Uint8Array,
  signatures: readonly ManifestSignature[],
  keys: TrustedKeys,
): void {
  let trusted = false;
  for (const signature of signatures) {
    const key = keys.get(signature.keyId);
    if (key === undefined) continue;
    if (!verifyEd25519(key, payload, signature.value)) {
      throw new AiregError("The release manifest signature verification failed.", {
        code: ErrorCode.Integrity,
      });
    }
    trusted = true;
  }
  if (!trusted)
    throw new AiregError("The release manifest is not signed by a trusted key.", {
      code: ErrorCode.Integrity,
    });
}

function parseManifestBody(doc: Fields): ReleaseManifest | undefined {
  if (doc.schema !== MANIFEST_SCHEMA) return undefined;
  const { adapter } = doc;
  if (adapter !== undefined && (typeof adapter !== "string" || !isAdapterId(adapter)))
    return undefined;
  if (typeof doc.channel !== "string" || !isChannel(doc.channel)) return undefined;
  const version = exactVersion(doc.version);
  if (version === undefined) return undefined;
  const stated = doc.minimum_version;
  const minimumVersion = stated === undefined || stated === null ? undefined : exactVersion(stated);
  if (stated !== undefined && stated !== null && minimumVersion === undefined) return undefined;
  if (minimumVersion !== undefined && !gte(version, minimumVersion)) return undefined;
  if (typeof doc.published_at !== "string" || !isTimestamp(doc.published_at)) return undefined;
  const artifacts = parseArtifacts(doc.artifacts);
  if (artifacts === undefined) return undefined;
  return {
    ...(adapter === undefined ? {} : { adapter }),
    channel: doc.channel,
    version,
    minimumVersion,
    publishedAt: doc.published_at,
    artifacts,
  };
}

function parseArtifacts(raw: unknown): ManifestArtifact[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ARTIFACTS) return undefined;
  const artifacts: ManifestArtifact[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!hasOnly(item, ARTIFACT_KEYS)) return undefined;
    const { name, sha256, size } = item;
    if (typeof name !== "string" || !ARTIFACT_NAME.test(name) || seen.has(name)) return undefined;
    if (typeof sha256 !== "string" || !isSha256Hex(sha256)) return undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size)) return undefined;
    if (size <= 0 || size > MAX_ARTIFACT_BYTES) return undefined;
    seen.add(name);
    artifacts.push({ name, sha256, size });
  }
  return artifacts;
}

function parseSignatures(raw: unknown): ManifestSignature[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SIGNATURES) return undefined;
  const signatures: ManifestSignature[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!hasOnly(item, SIGNATURE_KEYS)) return undefined;
    if (item.algorithm !== "ed25519") return undefined;
    const { key_id: keyId, value } = item;
    if (typeof keyId !== "string" || !KEY_ID.test(keyId) || seen.has(keyId)) return undefined;
    if (typeof value !== "string") return undefined;
    const decoded = decodeBase64(value, SIGNATURE_BYTES);
    if (decoded === undefined) return undefined;
    seen.add(keyId);
    signatures.push({ keyId, value: decoded });
  }
  return signatures;
}

/** Refuses `v1.2.3` and `1.02.3`: the stored path is built from this string. */
function exactVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseVersion(value);
  if (parsed === undefined || formatVersion(parsed) !== value) return undefined;
  return value;
}

function isTimestamp(value: string): boolean {
  return TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}
