import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import { sha256Hex } from "#core/fs/hash.ts";
import { decodeTrustedKeys } from "#core/release/keyring.ts";
import { versionBin } from "#core/release/layout.ts";
import { canonicalPayload, type ReleaseManifest } from "#core/release/manifest.ts";
import { binaryName, releasePlatform } from "#core/release/platform.ts";
import type { ReleaseStamp } from "#core/release/stamp.ts";
import { test } from "#test/kit/fixtures.ts";
import { installedVersion } from "./install.ts";
import { installRelease, probeRelease } from "./minimum-update.ts";

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
const PLATFORM = releasePlatform();
if (PLATFORM === undefined) throw new Error(`no release platform for ${process.platform}`);
const BINARY = binaryName(PLATFORM);

beforeEach(() => {
  stub.stamp = undefined;
});

/** Stands in for the compiled executable; the flow only writes and hashes it. */
function executable(version: string): Uint8Array {
  return new TextEncoder().encode(`#!/bin/sh\necho "${version}"\n`);
}

function stamped(): { stamp: ReleaseStamp; sign: (bytes: Uint8Array) => string } {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  const encoded = Buffer.from(String(jwk.x), "base64url").toString("base64");
  const keyring = Buffer.from(JSON.stringify({ release: encoded }), "utf8").toString("base64");
  const keys = decodeTrustedKeys(keyring);
  if (keys === undefined) throw new Error("keyring did not decode");
  return {
    stamp: { origin: ORIGIN, channel: "stable", keys },
    sign: (bytes) => sign(null, bytes, pair.privateKey).toString("base64"),
  };
}

/** The signed channel document, and the artifact bytes it vouches for. */
function channel(version: string, minimumVersion: string, binary: Uint8Array) {
  const keys = stamped();
  const manifest: ReleaseManifest = {
    channel: "stable",
    version,
    minimumVersion,
    publishedAt: "2026-09-17T09:00:00.000Z",
    artifacts: [{ name: BINARY, sha256: sha256Hex(binary), size: binary.byteLength }],
  };
  const document = {
    schema: "aireg-manifest.v1",
    channel: manifest.channel,
    version: manifest.version,
    minimum_version: manifest.minimumVersion,
    published_at: manifest.publishedAt,
    artifacts: manifest.artifacts.map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
      url: `${ORIGIN}/artifacts/v${version}/${entry.name}`,
    })),
    signatures: [
      {
        algorithm: "ed25519",
        key_id: "release",
        value: keys.sign(canonicalPayload(manifest)),
      },
    ],
  };
  return { keys, document };
}

function origin(document: unknown, artifact: Uint8Array): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === MANIFEST) {
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(`${ORIGIN}/artifacts/`)) return new Response(artifact, { status: 200 });
    return new Response("missing", { status: 404 });
  };
}

describe("minimum update from the signed channel", () => {
  test("installs the binary executable, and points current at it", async ({ tmp }) => {
    const binary = executable("0.2.0");
    const { keys, document } = channel("0.2.0", "0.1.0", binary);
    stub.stamp = keys.stamp;
    const $fetch = origin(document, binary);
    const home = tmp;
    const env = { AIREG_HOME: home };

    const found = await probeRelease(env, $fetch);
    expect(found?.minimumVersion).toBe("0.1.0");
    expect(found?.version).toBe("0.2.0");
    if (found === undefined) throw new Error("probe failed");

    await installRelease(found, env, $fetch);
    expect(await installedVersion(env)).toBe("0.2.0");

    const bin = versionBin("0.2.0", env);
    expect(await readFile(bin, "utf8")).toContain("0.2.0");
    // Placed executable, not left for a later chmod: the shim execs it directly.
    if (process.platform !== "win32") expect((await stat(bin)).mode & 0o111).not.toBe(0);
  });

  test("aborts before writing anything when the binary fails its checksum", async ({ tmp }) => {
    const { keys, document } = channel("0.2.0", "0.1.0", executable("0.2.0"));
    stub.stamp = keys.stamp;
    // Signed for one set of bytes, served another of the same length: signature
    // and size both still pass, so only the per-artifact sha256 can catch it.
    const $fetch = origin(document, executable("0.2.1"));
    const home = tmp;
    const env = { AIREG_HOME: home };

    const found = await probeRelease(env, $fetch);
    if (found === undefined) throw new Error("probe failed");
    await expect(installRelease(found, env, $fetch)).rejects.toThrow(/failed its checksum/);
    await expect(stat(join(home, "cli", "0.2.0", "aireg"))).rejects.toThrow();
  });

  test("records the channel's answer for the next run's floor check", async ({ tmp }) => {
    const binary = executable("0.2.0");
    const { keys, document } = channel("0.2.0", "0.1.0", binary);
    stub.stamp = keys.stamp;
    const home = tmp;

    await probeRelease({ AIREG_HOME: home }, origin(document, binary));
    expect(JSON.parse(await readFile(join(home, "state", "update-check.json"), "utf8"))).toEqual({
      checkedAt: expect.any(Number),
      latest: "0.2.0",
      sizeBytes: binary.byteLength,
      minimumVersion: "0.1.0",
    });
  });

  test("answers nothing when the channel is unreachable", async () => {
    stub.stamp = stamped().stamp;
    let asked = false;
    const offline: typeof fetch = async () => {
      asked = true;
      throw new Error("offline");
    };
    expect(await probeRelease({}, offline)).toBe(undefined);
    expect(asked).toBe(true);
  });

  test("probes nothing when the build names no channel", async () => {
    expect(await probeRelease({}, async () => new Response("", { status: 500 }))).toBe(undefined);
  });
});
