import type { KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { releaseBinary } from "#core/product.ts";
import { RELEASE_PLATFORMS } from "#core/release/platform.ts";
import { test } from "#test/kit/fixtures.ts";
import { encodeKeyring, releaseKey } from "#test/kit/release.ts";
import { privateKeyFromSeed, signManifest, verifySigned } from "./manifest.ts";

const MAX_ARTIFACTS = 8;

function keys(id: string): { privateKey: KeyObject; keyring: string; seed: string } {
  const { privateKey, encoded } = releaseKey();
  return {
    privateKey,
    keyring: encodeKeyring({ [id]: encoded }),
    seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("base64"),
  };
}

function files(dir: string, names: readonly string[]): string[] {
  return names.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, `fixture ${name}`);
    return path;
  });
}

describe("release manifest", () => {
  test("signs what the client verifier accepts, and nothing it would reject", ({ tmp }) => {
    const { privateKey, keyring } = keys("k1");
    const binaries = RELEASE_PLATFORMS.map((platform) => releaseBinary(platform));
    const extras = Array.from(
      { length: MAX_ARTIFACTS - binaries.length },
      (_, at) => `extra-${at}`,
    );
    const artifacts = files(tmp, [...binaries, ...extras]);
    const base = {
      channel: "stable" as const,
      version: "1.2.3",
      minimumVersion: "1.0.0",
      origin: "https://releases.example.com/aireg",
      keyId: "k1",
      privateKey,
    };

    const document = signManifest({ ...base, artifacts });
    const manifest = verifySigned(document, keyring, "stable");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.artifacts).toHaveLength(MAX_ARTIFACTS);

    const tampered = JSON.parse(document);
    tampered.artifacts[0].sha256 = "0".repeat(64);
    expect(() => verifySigned(JSON.stringify(tampered), keyring, "stable")).toThrow();
    expect(() => verifySigned(document, keyring, "canary")).toThrow();
    const over = signManifest({ ...base, artifacts: [...artifacts, ...files(tmp, ["one-more"])] });
    expect(() => verifySigned(over, keyring, "stable")).toThrow();
  });

  test("reads a base64 seed and lists each file by name, size and digest", ({ tmp }) => {
    const { keyring, seed } = keys("k1");
    const file = join(tmp, "aireg-linux-amd64");
    writeFileSync(file, "aireg");

    const document = signManifest({
      channel: "stable",
      version: "0.1.0",
      minimumVersion: "0.1.0",
      origin: "https://releases.example.com/aireg",
      artifacts: [file],
      keyId: "k1",
      privateKey: privateKeyFromSeed(seed),
    });

    const manifest = verifySigned(document, keyring, "stable");
    expect(manifest.artifacts).toEqual([
      {
        name: "aireg-linux-amd64",
        size: 5,
        sha256: "bed12b3d6680804a9cdd5d0a555c15c3440b2f3b593b7c89121cafd0c58a46b9",
      },
    ]);
    expect(JSON.parse(document).artifacts[0].url).toBe(
      "https://releases.example.com/aireg/artifacts/v0.1.0/aireg-linux-amd64",
    );
  });

  test("refuses a seed that is not 32 bytes", () => {
    expect(() => privateKeyFromSeed(Buffer.alloc(16).toString("base64"))).toThrow(/32-byte/);
  });
});
