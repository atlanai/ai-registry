import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { isRecord } from "#adapter/fields.ts";

export const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PUBLIC_KEY_BYTES = 32;
const MAX_KEYS = 8;

export const SIGNATURE_BYTES = 64;

export type TrustedKeys = ReadonlyMap<string, KeyObject>;

/** `Buffer.from` silently drops stray characters, so round-trip instead. */
export function decodeBase64(value: string, bytes: number): Uint8Array | undefined {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) return undefined;
  return new Uint8Array(decoded);
}

/**
 * Base64 of a JSON object mapping key id to a base64 raw Ed25519 public key.
 * A malformed keyring yields nothing, so a build trusts no one, not everyone.
 */
export function decodeTrustedKeys(encoded: string): TrustedKeys | undefined {
  const pairs = decodeJsonObject(encoded);
  if (pairs === undefined) return undefined;
  const keys = new Map<string, KeyObject>();
  for (const [keyId, value] of Object.entries(pairs)) {
    if (!KEY_ID.test(keyId) || typeof value !== "string") return undefined;
    const raw = decodeBase64(value, PUBLIC_KEY_BYTES);
    if (raw === undefined) return undefined;
    const key = publicKeyFrom(raw);
    if (key === undefined) return undefined;
    keys.set(keyId, key);
  }
  return keys.size === 0 || keys.size > MAX_KEYS ? undefined : keys;
}

function decodeJsonObject(encoded: string): Record<string, unknown> | undefined {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== encoded) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A raw key imported as a JWK: no dependency and no DER assembled by hand. */
function publicKeyFrom(raw: Uint8Array): KeyObject | undefined {
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") },
      format: "jwk",
    });
  } catch {
    return undefined;
  }
}

export function verifyEd25519(key: KeyObject, payload: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, payload, key, signature);
  } catch {
    return false;
  }
}
