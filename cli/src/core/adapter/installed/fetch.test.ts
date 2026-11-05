import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { RELEASE_ADAPTER_FILE } from "#core/product.ts";
import { decodeTrustedKeys } from "#core/release/keyring.ts";
import { canonicalPayload, type ReleaseManifest } from "#core/release/manifest.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import { downloadAdapter, resolveAdapter } from "./fetch.ts";

const ORIGIN = "https://releases.example.com/aireg";
const CHANNEL = `${ORIGIN}/adapters/acme/channels/stable/manifest.json`;
const VERSION_MANIFEST = `${ORIGIN}/adapters/acme/artifacts/v1.4.0/manifest.json`;
const ARTIFACT = `${ORIGIN}/adapters/acme/artifacts/v1.4.0/${RELEASE_ADAPTER_FILE}`;
const EVIL = "https://evil.example/pwn";
const payload = new TextEncoder().encode("export default { id: 'acme' };\n");

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
    adapter: "acme",
    channel: "stable",
    version: "1.4.0",
    minimumVersion: undefined,
    publishedAt: "2026-09-19T09:00:00.000Z",
    artifacts: [
      { name: RELEASE_ADAPTER_FILE, sha256: sha256Hex(payload), size: payload.byteLength },
    ],
    ...over,
  };
}

function document(manifest: ReleaseManifest, signature: string, url = ARTIFACT): string {
  return JSON.stringify({
    schema: "aireg-manifest.v1",
    adapter: manifest.adapter,
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimumVersion,
    published_at: manifest.publishedAt,
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact, url })),
    signatures: [{ algorithm: "ed25519", key_id: "release", value: signature }],
  });
}

function origin(bodies: Record<string, string>, bytes: Uint8Array, seen: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (init?.redirect !== "error") throw new Error(`${url} was fetched following redirects`);
    if (url in bodies) return new Response(bodies[url], { status: 200 });
    if (url === ARTIFACT) return new Response(bytes, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

describe("resolveAdapter", () => {
  test("reads the channel manifest and derives the artifact URL", async () => {
    const keys = stamped();
    const manifest = manifestOf();
    const seen: string[] = [];
    const $fetch = origin(
      { [CHANNEL]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      seen,
    );

    const release = await resolveAdapter({ id: "acme", version: undefined }, keys.stamp, $fetch);
    expect(release).toEqual({
      id: "acme",
      version: "1.4.0",
      plan: {
        kind: "manifest",
        url: ARTIFACT,
        name: RELEASE_ADAPTER_FILE,
        sha256: sha256Hex(payload),
        size: payload.byteLength,
      },
    });
    expect(seen).toEqual([CHANNEL]);
    expect(await downloadAdapter(release, $fetch)).toEqual(payload);
    expect(seen).toEqual([CHANNEL, ARTIFACT]);
  });

  test("pins through the version directory, and never fetches the manifest url field", async () => {
    const keys = stamped();
    const manifest = manifestOf();
    const seen: string[] = [];
    const $fetch = origin(
      { [VERSION_MANIFEST]: document(manifest, keys.sign(canonicalPayload(manifest)), EVIL) },
      payload,
      seen,
    );

    const release = await resolveAdapter({ id: "acme", version: "1.4.0" }, keys.stamp, $fetch);
    expect(release.plan.url).toBe(ARTIFACT);
    expect(seen).toEqual([VERSION_MANIFEST]);
    expect(await downloadAdapter(release, $fetch)).toEqual(payload);
    expect(seen).not.toContain(EVIL);
    expect(seen).not.toContain(CHANNEL);
  });

  test("accepts a pinned version signed for stable on a canary CLI", async () => {
    const keys = stamped();
    const stamp = { ...keys.stamp, channel: "canary" as const };
    const manifest = manifestOf();
    const seen: string[] = [];
    const $fetch = origin(
      { [VERSION_MANIFEST]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      seen,
    );

    const release = await resolveAdapter({ id: "acme", version: "1.4.0" }, stamp, $fetch);
    expect(release.version).toBe("1.4.0");
    expect(seen).toEqual([VERSION_MANIFEST]);
  });

  test("resolves an adapter whose minimum_version floor is above the CLI's own version", async () => {
    // `minimum_version` is a floor on the adapter's own line, not on the client.
    const keys = stamped();
    const manifest = manifestOf({ version: "1.4.0", minimumVersion: "1.2.0" });
    const $fetch = origin(
      { [CHANNEL]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      [],
    );
    const release = await resolveAdapter({ id: "acme", version: undefined }, keys.stamp, $fetch);
    expect(release.version).toBe("1.4.0");
  });

  test("refuses another adapter's signed release before downloading it", async () => {
    const keys = stamped();
    const manifest = manifestOf({ adapter: "other" });
    const seen: string[] = [];
    const $fetch = origin(
      { [CHANNEL]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      seen,
    );
    await expect(
      resolveAdapter({ id: "acme", version: undefined }, keys.stamp, $fetch),
    ).rejects.toMatchObject({
      code: ErrorCode.Integrity,
      message: "The release server offered adapter other, not acme.",
    });
    expect(seen).toEqual([CHANNEL]);
  });

  test("refuses a release that names no adapter", async () => {
    const keys = stamped();
    const { adapter: _, ...manifest } = manifestOf();
    const $fetch = origin(
      { [CHANNEL]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      [],
    );
    await expect(
      resolveAdapter({ id: "acme", version: undefined }, keys.stamp, $fetch),
    ).rejects.toMatchObject({
      code: ErrorCode.Integrity,
      message: "The release server offered a release that names no adapter, not acme.",
    });
  });

  test("accepts atlan's releases, which were signed before releases named their adapter", async () => {
    const keys = stamped();
    const { adapter: _, ...manifest } = manifestOf();
    const url = `${ORIGIN}/adapters/atlan/channels/stable/manifest.json`;
    const $fetch = origin(
      { [url]: document(manifest, keys.sign(canonicalPayload(manifest))) },
      payload,
      [],
    );
    const release = await resolveAdapter({ id: "atlan", version: undefined }, keys.stamp, $fetch);
    expect(release).toMatchObject({ id: "atlan", version: "1.4.0" });
  });
});
