import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { decodeTrustedKeys, type TrustedKeys } from "#core/release/keyring.ts";
import type { ReleaseManifest } from "#core/release/manifest.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";

export const RELEASE_ORIGIN = "https://releases.example.com/aireg";

/** A fresh Ed25519 pair, its public key raw and in base64 as a keyring holds it. */
export function releaseKey(): { privateKey: KeyObject; encoded: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, encoded: Buffer.from(String(jwk.x), "base64url").toString("base64") };
}

/** A keyring as a release build is stamped with: base64 of key id to public key. */
export function encodeKeyring(entries: Record<string, string>): string {
  return Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
}

export interface ReleaseSigner {
  keyring: string;
  keys: TrustedKeys;
  /** A stable-channel stamp at `origin` that trusts this key. */
  stamp: ReleaseStamp;
  sign(bytes: Uint8Array): string;
}

/** A fresh key trusted as `release`, and the signatures it makes. */
export function releaseSigner(origin = RELEASE_ORIGIN): ReleaseSigner {
  const { privateKey, encoded } = releaseKey();
  const ring = encodeKeyring({ release: encoded });
  const keys = decodeTrustedKeys(ring);
  if (keys === undefined) throw new Error("keyring did not decode");
  return {
    keyring: ring,
    keys,
    stamp: { origin, channel: "stable", keys },
    sign: (bytes) => sign(null, bytes, privateKey).toString("base64"),
  };
}

/** A manifest as a release server serves it, every artifact at `url`, signed by `keyId`. */
export function manifestDocument(
  manifest: ReleaseManifest,
  signature: string,
  url: string,
  keyId = "release",
): Record<string, unknown> {
  return {
    schema: "aireg-manifest.v1",
    adapter: manifest.adapter,
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimumVersion,
    published_at: manifest.publishedAt,
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, url })),
    signatures: [{ algorithm: "ed25519", key_id: keyId, value: signature }],
  };
}
