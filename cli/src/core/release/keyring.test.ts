import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decodeBase64, decodeTrustedKeys, SIGNATURE_BYTES, verifyEd25519 } from "./keyring.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(String(jwk.x), "base64url");
  return { privateKey, encoded: raw.toString("base64") };
}

function keyring(entries: Record<string, string>): string {
  return Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
}

describe("decodeTrustedKeys", () => {
  test("reads base64-of-JSON key id to raw Ed25519 key", () => {
    const first = keypair();
    const second = keypair();
    const keys = decodeTrustedKeys(keyring({ "release-1": first.encoded, r2: second.encoded }));
    expect([...(keys?.keys() ?? [])]).toEqual(["release-1", "r2"]);
  });

  test("fails closed on an unresolved, malformed or short keyring", () => {
    expect(decodeTrustedKeys("")).toBeUndefined();
    expect(decodeTrustedKeys("__RELEASE_KEYRING__")).toBeUndefined();
    expect(decodeTrustedKeys(keyring({}))).toBeUndefined();
    expect(decodeTrustedKeys(keyring({ ok: Buffer.alloc(31).toString("base64") }))).toBeUndefined();
    expect(decodeTrustedKeys(keyring({ "bad id": keypair().encoded }))).toBeUndefined();
    expect(decodeTrustedKeys(Buffer.from("[]", "utf8").toString("base64"))).toBeUndefined();
  });
});

describe("verifyEd25519", () => {
  test("accepts its own signature and rejects one byte of drift", () => {
    const { privateKey, encoded } = keypair();
    const keys = decodeTrustedKeys(keyring({ release: encoded }));
    const key = keys?.get("release");
    if (key === undefined) throw new Error("keyring did not decode");
    const payload = new TextEncoder().encode("release-manifest");
    const signature = new Uint8Array(sign(null, payload, privateKey));

    expect(verifyEd25519(key, payload, signature)).toBe(true);
    expect(verifyEd25519(key, new TextEncoder().encode("release-manifesu"), signature)).toBe(false);
    expect(verifyEd25519(key, payload, signature.slice(0, 10))).toBe(false);
  });
});

describe("decodeBase64", () => {
  test("is strict about padding, length and stray characters", () => {
    const raw = new Uint8Array(SIGNATURE_BYTES).fill(7);
    const encoded = Buffer.from(raw).toString("base64");
    expect(decodeBase64(encoded, SIGNATURE_BYTES)).toEqual(raw);
    expect(decodeBase64(encoded.replace(/=+$/, ""), SIGNATURE_BYTES)).toBeUndefined();
    expect(decodeBase64(`${encoded} `, SIGNATURE_BYTES)).toBeUndefined();
    expect(decodeBase64(encoded, 32)).toBeUndefined();
  });
});
