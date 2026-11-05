import { describe, expect, test } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { type ReleaseSigner, releaseSigner } from "#test/kit/release.ts";
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

/** Signs `manifest`'s canonical payload, whatever `over` then says. */
function signed(
  keyring: ReleaseSigner,
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
  test("accepts a manifest signed by a trusted key", () => {
    const keyring = releaseSigner();
    const parsed = verifyManifest(signed(keyring), keyring.keys, "stable");
    expect(parsed).toEqual(manifest);
    expect(artifactNamed(parsed, NAME)?.sha256).toBe(SHA);
    expect(artifactNamed(parsed, "other.tgz")).toBeUndefined();
  });

  test("rejects a tampered manifest", () => {
    const keyring = releaseSigner();
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

  test("separates a substituted publisher from an unknown one", () => {
    const keyring = releaseSigner();
    // Same key id, different key: a broken or substituted publisher is refused, not ignored.
    expect(
      failure(() => verifyManifest(signed(releaseSigner()), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/verification failed/),
    });
    // An id the keyring does not carry.
    expect(
      failure(() => verifyManifest(signed(keyring, {}, "rotated-out"), keyring.keys, "stable")),
    ).toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/not signed by a trusted/),
    });
  });

  test("rejects an unsigned, misencoded or over-long manifest", () => {
    const keyring = releaseSigner();
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

  test("refuses a manifest served for another channel, and unknown fields", () => {
    const keyring = releaseSigner();
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

  test("accepts a pin whose signed channel is not the one this build asked for", () => {
    const keyring = releaseSigner();
    expect(verifyManifest(signed(keyring), keyring.keys).channel).toBe("stable");
  });

  test("refuses a floor newer than the release, and a non-exact version", () => {
    const keyring = releaseSigner();
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
  test("signs the name, so it cannot be changed to another adapter", () => {
    const keyring = releaseSigner();
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
  test("covers only what the client acts on, so `url` cannot be signed into it", () => {
    const payload = new TextDecoder().decode(canonicalPayload(manifest));
    expect(payload).toBe(
      '{"schema":"aireg-manifest.v1","channel":"stable","version":"0.2.0",' +
        '"minimum_version":"0.1.0","published_at":"2026-09-17T09:00:00.000Z",' +
        `"artifacts":[{"name":"${NAME}","sha256":"${SHA}","size":4096}]}`,
    );
  });

  test("states an absent floor rather than omitting the key", () => {
    const payload = canonicalPayload({ ...manifest, minimumVersion: undefined });
    expect(new TextDecoder().decode(payload)).toContain('"minimum_version":null');
  });
});
