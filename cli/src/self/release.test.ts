import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "#core/fs/hash.ts";
import { releaseBinary } from "#core/product.ts";
import { decodeTrustedKeys } from "#core/release/keyring.ts";
import { canonicalPayload, type ReleaseManifest } from "#core/release/manifest.ts";
import { releasePlatform } from "#core/release/platform.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import { downloadRelease, resolveRelease } from "./release.ts";

// The stamp is build-time only by design, so a test substitutes one here
// rather than the code growing an environment override to let it in.
const stub = vi.hoisted(() => ({ stamp: undefined as ReleaseStamp | undefined }));

vi.mock("#core/release/stamp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#core/release/stamp.ts")>();
  return {
    ...actual,
    releaseStamp: (env?: NodeJS.ProcessEnv) => stub.stamp ?? actual.releaseStamp(env),
  };
});

const ORIGIN = "https://releases.example.com/aireg";
const MANIFEST = `${ORIGIN}/channels/stable/manifest.json`;
/** This host's own artifact, so the derived URL is the one the client builds. */
const PLATFORM = releasePlatform();
if (PLATFORM === undefined) throw new Error(`no release platform for ${process.platform}`);
const BINARY = releaseBinary(PLATFORM);
const ARTIFACT = `${ORIGIN}/artifacts/v0.2.0/${BINARY}`;
const EVIL = "https://evil.example/pwn";

const payload = new TextEncoder().encode("a standalone executable");

function stamped(): { stamp: ReleaseStamp; sign: (bytes: Uint8Array) => string } {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  const encoded = Buffer.from(String(jwk.x), "base64url").toString("base64");
  const keyring = Buffer.from(JSON.stringify({ release: encoded }), "utf8").toString("base64");
  const keys = decodeTrustedKeys(keyring);
  if (keys === undefined) throw new Error("keyring did not decode");
  const stamp: ReleaseStamp = { origin: ORIGIN, channel: "stable", keys };
  return { stamp, sign: (bytes) => sign(null, bytes, pair.privateKey).toString("base64") };
}

function manifestOf(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    channel: "stable",
    version: "0.2.0",
    minimumVersion: "0.1.0",
    publishedAt: "2026-09-17T09:00:00.000Z",
    artifacts: [{ name: BINARY, sha256: sha256Hex(payload), size: payload.byteLength }],
    ...over,
  };
}

/** The wire document, with the unsigned `url` a publisher may add for humans. */
function document(
  manifest: ReleaseManifest,
  signature: string,
  url = ARTIFACT,
  keyId = "release",
): string {
  return JSON.stringify({
    schema: "aireg-manifest.v1",
    adapter: manifest.adapter,
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimumVersion,
    published_at: manifest.publishedAt,
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, url })),
    signatures: [{ algorithm: "ed25519", key_id: keyId, value: signature }],
  });
}

function origin(body: string, bytes: Uint8Array, seen: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (init?.redirect !== "error") throw new Error(`${url} was fetched following redirects`);
    if (url === MANIFEST) return new Response(body, { status: 200 });
    if (url === ARTIFACT) return new Response(bytes, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

beforeEach(() => {
  stub.stamp = undefined;
});

describe("resolveRelease from the signed channel", () => {
  test("reads the stable manifest and derives the artifact URL", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf();
    const seen: string[] = [];
    const $fetch = origin(document(manifest, keys.sign(canonicalPayload(manifest))), payload, seen);

    const release = await resolveRelease({}, $fetch);
    expect(release.version).toBe("0.2.0");
    expect(release.plan).toEqual({
      kind: "manifest",
      url: ARTIFACT,
      name: BINARY,
      sha256: sha256Hex(payload),
      size: payload.byteLength,
    });
    expect(seen).toEqual([MANIFEST]);
    expect(release.minimumVersion).toBe("0.1.0");
    expect(await downloadRelease(release, $fetch)).toEqual(payload);
    expect(seen).toEqual([MANIFEST, ARTIFACT]);
  });

  test("never fetches the manifest's own url field", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf();
    const seen: string[] = [];
    const body = document(manifest, keys.sign(canonicalPayload(manifest)), EVIL);
    const $fetch = origin(body, payload, seen);

    const release = await resolveRelease({}, $fetch);
    expect(release.plan.kind === "manifest" && release.plan.url).toBe(ARTIFACT);
    await downloadRelease(release, $fetch);
    expect(seen).toEqual([MANIFEST, ARTIFACT]);
  });

  test("aborts the update when the payload does not match the signed digest", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf();
    const body = document(manifest, keys.sign(canonicalPayload(manifest)));
    const swapped = new TextEncoder().encode("a standalone executablE");
    const $fetch = origin(body, swapped, []);

    const release = await resolveRelease({}, $fetch);
    await expect(downloadRelease(release, $fetch)).rejects.toThrow(/failed its checksum/);
  });

  test("aborts the update when the payload is not the signed size", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf();
    const body = document(manifest, keys.sign(canonicalPayload(manifest)));
    const $fetch = origin(body, new TextEncoder().encode("short"), []);

    const release = await resolveRelease({}, $fetch);
    await expect(downloadRelease(release, $fetch)).rejects.toThrow(/wrong size/);
  });

  test("refuses a manifest this build has no key for", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const signature = keys.sign(canonicalPayload(manifestOf()));
    const body = document(manifestOf(), signature, ARTIFACT, "rotated-out");
    await expect(resolveRelease({}, origin(body, payload, []))).rejects.toThrow(
      /not signed by a trusted key/,
    );
  });

  test("refuses a release the channel does not carry the payload for", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf({
      artifacts: [{ name: "aireg-plan9-sparc", sha256: "c".repeat(64), size: 9 }],
    });
    const body = document(manifest, keys.sign(canonicalPayload(manifest)));
    await expect(resolveRelease({}, origin(body, payload, []))).rejects.toThrow(
      new RegExp(`has no ${BINARY}`),
    );
  });

  test("refuses an adapter's release served as its own", async () => {
    const keys = stamped();
    stub.stamp = keys.stamp;
    const manifest = manifestOf({ adapter: "acme" });
    const body = document(manifest, keys.sign(canonicalPayload(manifest)));
    await expect(resolveRelease({}, origin(body, payload, []))).rejects.toThrow(
      /offered adapter acme, not aireg/,
    );
  });
});

// There is no second source: an unverifiable update is refused rather than
// resolved to a download that cannot exist.
describe("with no channel to read", () => {
  test("refuses an unstamped build rather than reach for an unsigned binary", async () => {
    await expect(resolveRelease({}, async () => new Response())).rejects.toThrow(
      /does not update itself/,
    );
  });
});
