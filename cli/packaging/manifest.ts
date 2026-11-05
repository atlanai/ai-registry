import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { sha256Hex } from "#core/fs/hash.ts";
import { decodeTrustedKeys } from "#core/release/keyring.ts";
import {
  canonicalPayload,
  MANIFEST_SCHEMA,
  type ReleaseManifest,
  verifyManifest,
} from "#core/release/manifest.ts";
import { artifactUrl, type Channel } from "#core/release/origin.ts";

/** PKCS#8 header for a 32-byte Ed25519 seed (RFC 8410); only the signer ever holds a private key. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface SignOptions {
  channel: Channel;
  version: string;
  minimumVersion: string | undefined;
  origin: string;
  /** Paths of the files to list; each is named by its basename. */
  artifacts: readonly string[];
  keyId: string;
  privateKey: KeyObject;
  now?: Date;
}

/** A base64 32-byte Ed25519 seed, as the release workflow keeps it in its secret store. */
export function privateKeyFromSeed(encoded: string): KeyObject {
  const seed = Buffer.from(encoded.trim(), "base64");
  if (seed.byteLength !== 32)
    throw new Error("the signing key must be a base64 32-byte Ed25519 seed");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Uses the client's own schema and payload, so CI cannot sign what an installed aireg rejects.
 * `url` sits outside the signed payload, so it is added after signing.
 */
export function signManifest(options: SignOptions): string {
  const artifacts = options.artifacts.map((path) => {
    const name = basename(path);
    const url = artifactUrl(options.origin, options.version, name);
    if (url === undefined)
      throw new Error(`cannot derive an artifact URL for ${name} at ${options.origin}`);
    return { name, sha256: sha256Hex(readFileSync(path)), size: statSync(path).size, url };
  });
  const manifest: ReleaseManifest = {
    channel: options.channel,
    version: options.version,
    minimumVersion: options.minimumVersion,
    publishedAt: (options.now ?? new Date()).toISOString(),
    artifacts: artifacts.map(({ name, sha256: digest, size }) => ({ name, sha256: digest, size })),
  };
  const signature = sign(null, canonicalPayload(manifest), options.privateKey);
  const doc: Record<string, unknown> = {
    schema: MANIFEST_SCHEMA,
    channel: manifest.channel,
    version: manifest.version,
  };
  if (manifest.minimumVersion !== undefined) doc.minimum_version = manifest.minimumVersion;
  doc.published_at = manifest.publishedAt;
  doc.artifacts = artifacts;
  doc.signatures = [
    { algorithm: "ed25519", key_id: options.keyId, value: signature.toString("base64") },
  ];
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The same call an installed aireg makes, against the base64 keyring compiled into it. */
export function verifySigned(raw: string, keyring: string, channel: Channel): ReleaseManifest {
  const keys = decodeTrustedKeys(keyring);
  if (keys === undefined) throw new Error("the trusted keyring is empty or malformed");
  return verifyManifest(raw, keys, channel);
}
