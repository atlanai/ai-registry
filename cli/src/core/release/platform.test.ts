import { describe, expect, test } from "vitest";
import { releasePlatform, requireReleasePlatform } from "./platform.ts";

describe("releasePlatform", () => {
  test("names only the platforms a standalone build is published for", () => {
    // Node says `x64`; the published artifact says `amd64`, like uname and Go.
    expect(releasePlatform("linux", "x64")).toBe("linux-amd64");
    expect(releasePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(releasePlatform("win32", "x64")).toBe("windows-amd64");
    expect(releasePlatform("win32", "ia32")).toBeUndefined();
    expect(releasePlatform("linux", "ppc64")).toBeUndefined();
    // Nothing is composed from an unvetted string: the filename is a path segment.
    expect(releasePlatform("../..", "x64")).toBeUndefined();
    expect(releasePlatform("linux", "../..")).toBeUndefined();
    // A Map lookup, so these miss rather than returning off Object.prototype.
    expect(releasePlatform("constructor", "constructor")).toBeUndefined();
    expect(releasePlatform("toString", "x64")).toBeUndefined();
  });
});

describe("requireReleasePlatform", () => {
  test("fails loudly rather than deriving a URL for a platform with no build", () => {
    expect(requireReleasePlatform("linux", "x64")).toBe("linux-amd64");
    expect(() => requireReleasePlatform("freebsd", "arm64")).toThrow(/No aireg build/);
  });
});
