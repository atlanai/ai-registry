import { describe, expect, test } from "vitest";
import { bumpVersion, compareVersion, formatVersion, gte, parseVersion } from "./semver.ts";

describe("parseVersion", () => {
  test("reads a plain triple", () => {
    expect(parseVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(formatVersion(parseVersion("0.10.0")!)).toBe("0.10.0");
  });

  test("refuses what SemVer 2.0.0 does: a v prefix and leading zeros", () => {
    expect(parseVersion("v1.2.3")).toBeUndefined();
    expect(parseVersion("01.10.0")).toBeUndefined();
    expect(parseVersion("1.02.0")).toBeUndefined();
    expect(parseVersion("1.0.00")).toBeUndefined();
    expect(parseVersion("1.0.0-01")).toBeUndefined();
    expect(parseVersion("1.0.0-beta..1")).toBeUndefined();
    expect(parseVersion("1.0.0-0.0a.alpha-1")?.prerelease).toEqual(["0", "0a", "alpha-1"]);
  });

  test("keeps a prerelease and drops build metadata", () => {
    expect(parseVersion("1.0.0-beta.1+build")?.prerelease).toEqual(["beta", "1"]);
  });

  test("refuses ranges and leftover text", () => {
    expect(parseVersion("^1.2.3")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("abc")).toBeUndefined();
  });
});

describe("compareVersion", () => {
  test("orders by major, minor, patch, then prerelease", () => {
    const a = parseVersion("1.2.3")!;
    expect(compareVersion(a, parseVersion("1.2.4")!)).toBe(-1);
    expect(compareVersion(a, parseVersion("1.3.0")!)).toBe(-1);
    expect(compareVersion(parseVersion("2.0.0")!, a)).toBe(1);
    expect(compareVersion(parseVersion("1.0.0-beta")!, parseVersion("1.0.0")!)).toBe(-1);
    expect(compareVersion(a, a)).toBe(0);
  });
});

describe("gte", () => {
  test("treats the current CLI as new enough at equality", () => {
    expect(gte("0.2.0", "0.2.0")).toBe(true);
    expect(gte("0.2.1", "0.2.0")).toBe(true);
    expect(gte("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("bumpVersion", () => {
  test("starts a first release at 0.1.0", () => {
    expect(bumpVersion(undefined)).toBe("0.1.0");
  });

  test("moves the part it is asked to, and resets the ones below it", () => {
    expect(bumpVersion("1.2.3")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });
});
