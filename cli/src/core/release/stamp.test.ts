import { describe, expect, test } from "vitest";
import { releaseSigner } from "#test/kit/release.ts";
import { releaseStamp } from "./stamp.ts";

describe("releaseStamp", () => {
  test("has nothing to read in a source or unstamped build", () => {
    expect(releaseStamp({})).toBeUndefined();
    expect(releaseStamp({}, "prod", "")).toBeUndefined();
    expect(releaseStamp({}, "", releaseSigner().keyring)).toBeUndefined();
    expect(
      releaseStamp({}, "https://releases.example.com/aireg", "__RELEASE_KEYRING__"),
    ).toBeUndefined();
  });

  test("takes a channel out of the closed set, and nothing else", () => {
    const keys = releaseSigner().keyring;
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
