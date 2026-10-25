import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { decodeTrustedKeys, type TrustedKeys } from "./keyring.ts";
import {
  artifactNamed,
  canonicalPayload,
  MANIFEST_SCHEMA,
  type ReleaseManifest,
  verifyManifest,
} from "./manifest.ts";

const NAME = "aireg-linux-amd64";
const SHA = "a".repeat(64);

const manifest: ReleaseManifest = {
  channel: "stable",
  version: "0.2.0",
  minimumVersion: "0.1.0",
  publishedAt: "2026-09-17T09:00:00.000Z",
  artifacts: [{ name: NAME, sha256: SHA, size: 4096 }],
};

function signer(): { keys: TrustedKeys; sign: (payload: Uint8Array) => string } {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  const encoded = Buffer.from(String(jwk.x), "base64url").toString("base64");
  const keyring = Buffer.from(JSON.stringify({ release: encoded }), "utf8").toString("base64");
  const keys = decodeTrustedKeys(keyring);
  if (keys === undefined) throw new Error("keyring did not decode");
  return { keys, sign: (payload) => sign(null, payload, pair.privateKey).toString("base64") };
}

/** The wire document a publisher would upload, plus whatever `over` changes. */
function document(
  over: Record<string, unknown> = {},
  signature = "",
  keyId = "release",
): Record<string, unknown> {
  return {
    schema: MANIFEST_SCHEMA,
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimumVersion,
    published_at: manifest.publishedAt,
    artifacts: [{ name: NAME, sha256: SHA, size: 4096 }],
    signatures: [{ algorithm: "ed25519", key_id: keyId, value: signature }],
    ...over,
  };
}

/** Signed over the canonical payload of `manifest`, whatever `over` then says. */
function signed(
  keyring: ReturnType<typeof signer>,
  over: Record<string, unknown> = {},
  keyId = "release",
): string {
  return JSON.stringify(document(over, keyring.sign(canonicalPayload(manifest)), keyId));
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("verifyManifest", () => {
  it("accepts a manifest signed by a trusted key", () => {
    const keyring = signer();
    const parsed = verifyManifest(signed(keyring), keyring.keys, "stable");
    expect(parsed).toEqual(manifest);
    expect(artifactNamed(parsed, NAME)?.sha256).toBe(SHA);
    expect(artifactNamed(parsed, "other.tgz")).toBeUndefined();
  });

  it("rejects a tampered manifest", () => {
    const keyring = signer();
    const raw = signed(keyring, { version: "9.9.9" });
    expect(failure(() => verifyManifest(raw, keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/verification failed/),
    });

    const artifacts = [{ name: NAME, sha256: "b".repeat(64), size: 4096 }];
    expect(
      failure(() => verifyManifest(signed(keyring, { artifacts }), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/verification failed/),
    });
  });

  it("separates a substituted publisher from an unknown one", () => {
    const keyring = signer();
    // Same key id, a different key: the publisher this build trusts is broken
    // or substituted, so the manifest is refused rather than merely ignored.
    expect(failure(() => verifyManifest(signed(signer()), keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/verification failed/),
    });
    // An id the keyring does not carry: nothing here is trusted at all.
    expect(
      failure(() => verifyManifest(signed(keyring, {}, "rotated-out"), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/not signed by a trusted/),
    });
  });

  it("rejects an unsigned, misencoded or over-long manifest", () => {
    const keyring = signer();
    expect(
      failure(() => verifyManifest(signed(keyring, { signatures: [] }), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/signature is malformed/),
    });
    expect(failure(() => verifyManifest("{", keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Invalid,
      message: expect.stringMatching(/not valid JSON/),
    });
    expect(failure(() => verifyManifest("", keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Invalid,
      message: expect.stringMatching(/size is invalid/),
    });
    const rsa = signed(keyring, {
      signatures: [{ algorithm: "rsa", key_id: "release", value: "x" }],
    });
    expect(failure(() => verifyManifest(rsa, keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/signature is malformed/),
    });
  });

  it("refuses a manifest served for another channel, and unknown fields", () => {
    const keyring = signer();
    expect(failure(() => verifyManifest(signed(keyring), keyring.keys, "canary"))).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/is for stable, not canary/),
    });
    expect(
      failure(() => verifyManifest(signed(keyring, { extra: 1 }), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Invalid,
      message: expect.stringMatching(/unexpected fields/),
    });
  });

  it("accepts a pin whose signed channel is not the one this build asked for", () => {
    const keyring = signer();
    expect(verifyManifest(signed(keyring), keyring.keys).channel).toBe("stable");
  });

  it("refuses a floor newer than the release, and a non-exact version", () => {
    const keyring = signer();
    const ahead = signed(keyring, { minimum_version: "0.9.0" });
    expect(failure(() => verifyManifest(ahead, keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Invalid,
      message: expect.stringMatching(/incompatible/),
    });
    expect(
      failure(() => verifyManifest(signed(keyring, { version: "v0.2.0" }), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Invalid,
      message: expect.stringMatching(/incompatible/),
    });
  });
});

describe("a release that names its adapter", () => {
  it("signs the name, so it cannot be changed to another adapter", () => {
    const keyring = signer();
    const raw = JSON.stringify(
      document(
        { adapter: "acme" },
        keyring.sign(canonicalPayload({ ...manifest, adapter: "other" })),
      ),
    );
    expect(failure(() => verifyManifest(raw, keyring.keys, "stable"))).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/signature verification failed/),
    });
  });
});

describe("canonicalPayload", () => {
  it("covers only what the client acts on, so `url` cannot be signed into it", () => {
    const payload = new TextDecoder().decode(canonicalPayload(manifest));
    expect(payload).toBe(
      '{"schema":"aireg-manifest.v1","channel":"stable","version":"0.2.0",' +
        '"minimum_version":"0.1.0","published_at":"2026-09-17T09:00:00.000Z",' +
        `"artifacts":[{"name":"${NAME}","sha256":"${SHA}","size":4096}]}`,
    );
  });

  it("states an absent floor rather than omitting the key", () => {
    const payload = canonicalPayload({ ...manifest, minimumVersion: undefined });
    expect(new TextDecoder().decode(payload)).toContain('"minimum_version":null');
  });
});
