import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { releaseStamp } from "./stamp.ts";

function keyring(): string {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const encoded = Buffer.from(String(jwk.x), "base64url").toString("base64");
  return Buffer.from(JSON.stringify({ release: encoded }), "utf8").toString("base64");
}

describe("releaseStamp", () => {
  test("has nothing to read in a source or unstamped build", () => {
    expect(releaseStamp({})).toBeUndefined();
    expect(releaseStamp({}, "prod", "")).toBeUndefined();
    expect(releaseStamp({}, "", keyring())).toBeUndefined();
    expect(
      releaseStamp({}, "https://releases.example.com/aireg", "__RELEASE_KEYRING__"),
    ).toBeUndefined();
  });

  test("takes a channel out of the closed set, and nothing else", () => {
    const keys = keyring();
    expect(
      releaseStamp({ AIREG_RELEASE_CHANNEL: "canary" }, "https://releases.example.com/aireg", keys)
        ?.channel,
    ).toBe("canary");
    expect(
      releaseStamp({ AIREG_RELEASE_CHANNEL: "nightly" }, "https://releases.example.com/aireg", keys)
        ?.channel,
    ).toBe("stable");
  });
});
