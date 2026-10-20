import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  compareVersion,
  formatVersion,
  gte,
  MAX_RANGE,
  maxSatisfying,
  parseRange,
  parseVersion,
  satisfies,
} from "./semver.ts";

describe("parseVersion", () => {
  it("reads a plain triple", () => {
    expect(parseVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(formatVersion(parseVersion("0.10.0")!)).toBe("0.10.0");
  });

  it("refuses what SemVer 2.0.0 does: a v prefix and leading zeros", () => {
    expect(parseVersion("v1.2.3")).toBeUndefined();
    expect(parseVersion("01.10.0")).toBeUndefined();
    expect(parseVersion("1.02.0")).toBeUndefined();
    expect(parseVersion("1.0.00")).toBeUndefined();
    expect(parseVersion("1.0.0-01")).toBeUndefined();
    expect(parseVersion("1.0.0-beta..1")).toBeUndefined();
    expect(parseVersion("1.0.0-0.0a.alpha-1")?.prerelease).toEqual(["0", "0a", "alpha-1"]);
  });

  it("keeps a prerelease and drops build metadata", () => {
    expect(parseVersion("1.0.0-beta.1+build")?.prerelease).toEqual(["beta", "1"]);
  });

  it("refuses ranges and leftover text", () => {
    expect(parseVersion("^1.2.3")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("abc")).toBeUndefined();
  });
});

describe("compareVersion", () => {
  it("orders by major, minor, patch, then prerelease", () => {
    const a = parseVersion("1.2.3")!;
    expect(compareVersion(a, parseVersion("1.2.4")!)).toBe(-1);
    expect(compareVersion(a, parseVersion("1.3.0")!)).toBe(-1);
    expect(compareVersion(parseVersion("2.0.0")!, a)).toBe(1);
    expect(compareVersion(parseVersion("1.0.0-beta")!, parseVersion("1.0.0")!)).toBe(-1);
    expect(compareVersion(a, a)).toBe(0);
  });
});

describe("gte", () => {
  it("treats the current CLI as new enough at equality", () => {
    expect(gte("0.2.0", "0.2.0")).toBe(true);
    expect(gte("0.2.1", "0.2.0")).toBe(true);
    expect(gte("0.1.9", "0.2.0")).toBe(false);
  });
});

describe("bumpVersion", () => {
  it("starts a first release at 0.1.0", () => {
    expect(bumpVersion(undefined)).toBe("0.1.0");
  });

  it("moves the part it is asked to, and resets the ones below it", () => {
    expect(bumpVersion("1.2.3")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });
});

/** Which of `versions` satisfy `range`. */
const within = (range: string, ...versions: string[]) =>
  versions.filter((version) => satisfies(version, range));

describe("version ranges", () => {
  it("reads a comparator against a full version", () => {
    const versions = ["1.1.9", "1.2.0", "1.2.1"];
    expect(within("=1.2.0", ...versions)).toEqual(["1.2.0"]);
    expect(within("1.2.0", ...versions)).toEqual(["1.2.0"]);
    expect(within(">1.2.0", ...versions)).toEqual(["1.2.1"]);
    expect(within(">=1.2.0", ...versions)).toEqual(["1.2.0", "1.2.1"]);
    expect(within("<1.2.0", ...versions)).toEqual(["1.1.9"]);
    expect(within("<=1.2.0", ...versions)).toEqual(["1.1.9", "1.2.0"]);
  });

  it("reads a caret up to the next leftmost non-zero number, on 0.x too", () => {
    const versions = [
      "0.0.3",
      "0.0.4",
      "0.3.1",
      "0.3.2",
      "0.3.9",
      "0.4.0",
      "1.2.3",
      "1.9.0",
      "2.0.0",
    ];
    expect(within("^1.2.3", ...versions)).toEqual(["1.2.3", "1.9.0"]);
    expect(within("^1.2", ...versions)).toEqual(["1.2.3", "1.9.0"]);
    expect(within("^1", ...versions)).toEqual(["1.2.3", "1.9.0"]);
    expect(within("^0.3.2", ...versions)).toEqual(["0.3.2", "0.3.9"]);
    expect(within("^0.0.3", ...versions)).toEqual(["0.0.3"]);
    expect(within("^0.0", ...versions)).toEqual(["0.0.3", "0.0.4"]);
    expect(within("^0", ...versions)).toEqual([
      "0.0.3",
      "0.0.4",
      "0.3.1",
      "0.3.2",
      "0.3.9",
      "0.4.0",
    ]);
    expect(within("^1.x", ...versions)).toEqual(["1.2.3", "1.9.0"]);
  });

  it("reads a tilde up to the next minor, or the next major when only that is given", () => {
    const versions = [
      "1.2.2",
      "1.2.3",
      "1.2.9",
      "1.3.0",
      "1.9.0",
      "2.0.0",
      "0.0.1",
      "0.0.9",
      "0.1.0",
    ];
    expect(within("~1.2.3", ...versions)).toEqual(["1.2.3", "1.2.9"]);
    expect(within("~1.2", ...versions)).toEqual(["1.2.2", "1.2.3", "1.2.9"]);
    expect(within("~1", ...versions)).toEqual(["1.2.2", "1.2.3", "1.2.9", "1.3.0", "1.9.0"]);
    expect(within("~0.0.1", ...versions)).toEqual(["0.0.1", "0.0.9"]);
  });

  it("reads a partial version as every version with the numbers it gives", () => {
    const versions = ["0.9.0", "1.0.0", "1.2.0", "1.2.7", "1.3.0", "2.0.0"];
    expect(within("1", ...versions)).toEqual(["1.0.0", "1.2.0", "1.2.7", "1.3.0"]);
    expect(within("1.x", ...versions)).toEqual(["1.0.0", "1.2.0", "1.2.7", "1.3.0"]);
    expect(within("1.X.*", ...versions)).toEqual(["1.0.0", "1.2.0", "1.2.7", "1.3.0"]);
    expect(within("1.2", ...versions)).toEqual(["1.2.0", "1.2.7"]);
    expect(within("1.2.x", ...versions)).toEqual(["1.2.0", "1.2.7"]);
    expect(within("*", ...versions)).toEqual(versions);
    expect(within("x", ...versions)).toEqual(versions);
  });

  it("ANDs comparators separated by spaces and ORs sets separated by ||", () => {
    const versions = ["1.0.0", "1.5.0", "2.0.0", "3.1.0", "4.0.0"];
    expect(within(">=1.5.0 <3.0.0", ...versions)).toEqual(["1.5.0", "2.0.0"]);
    expect(within("  >=1.5.0   <3.0.0 ", ...versions)).toEqual(["1.5.0", "2.0.0"]);
    expect(within("^1.0.0 || ^3.0.0", ...versions)).toEqual(["1.0.0", "1.5.0", "3.1.0"]);
    expect(within("1.0.0||4", ...versions)).toEqual(["1.0.0", "4.0.0"]);
    expect(within("<1.5.0 || >=2.0.0 <4.0.0", ...versions)).toEqual(["1.0.0", "2.0.0", "3.1.0"]);
  });

  it("admits a prerelease only where a comparator of its set names one of that release", () => {
    expect(
      within(">=1.2.3-rc.1", "1.2.3-rc.0", "1.2.3-rc.2", "1.2.3", "1.3.0", "1.3.0-rc.1"),
    ).toEqual(["1.2.3-rc.2", "1.2.3", "1.3.0"]);
    expect(within("^1.2.3", "1.2.4-rc.1", "1.3.0-beta", "1.2.3")).toEqual(["1.2.3"]);
    expect(within("*", "1.0.0-rc.1")).toEqual([]);
    expect(within("^1.2.3-beta.2", "1.2.3-beta.4", "1.2.4-beta.1", "1.9.0")).toEqual([
      "1.2.3-beta.4",
      "1.9.0",
    ]);
    // Each set is read on its own, so the other set's prerelease admits nothing here.
    expect(within("^2.0.0 || =1.0.0-rc.1", "2.1.0-rc.1", "1.0.0-rc.1")).toEqual(["1.0.0-rc.1"]);
  });

  it("orders by precedence, so build metadata never decides", () => {
    expect(within("=1.2.3", "1.2.3+build.5")).toEqual(["1.2.3+build.5"]);
    expect(within(">1.2.3+build.1", "1.2.3+build.9", "1.2.4")).toEqual(["1.2.4"]);
  });

  it("refuses what the grammar does not take", () => {
    for (const text of [
      "",
      " ",
      "||",
      "^1 ||",
      "|| ^1",
      ">= 1.2.3",
      ">=1.2",
      "<1",
      "=1.x",
      "^",
      "~",
      "^*",
      "~x",
      "^^1",
      "1.x.2",
      "*.1",
      "1.2.3.4",
      "01.2",
      "v1.2.3",
      "1.2.3\t",
      "\t1.2.3",
      "latest",
      "1 - 2",
      "1.2.3 |  | 2",
      `${"1 ".repeat(MAX_RANGE / 2)}1`,
    ]) {
      expect(parseRange(text), text).toBeUndefined();
    }
    expect(parseRange(`>=1.0.0 ${" ".repeat(MAX_RANGE - 14)}<2.0.0`)).toBeDefined();
    expect(satisfies("1.2.3", "not a range")).toBe(false);
  });

  it("satisfies nothing with a version that is not SemVer", () => {
    expect(satisfies("v1.2.3", "*")).toBe(false);
    expect(satisfies("1.2", ">=1.0.0")).toBe(false);
    expect(satisfies("nightly", "*")).toBe(false);
  });

  it("picks the highest satisfying version, as written", () => {
    const versions = ["1.2.0", "1.10.0", "1.9.0", "2.0.0", "1.11.0-rc.1", "junk"];
    expect(maxSatisfying(versions, "^1.2.0")).toBe("1.10.0");
    expect(maxSatisfying(versions, parseRange("~1.9")!)).toBe("1.9.0");
    expect(maxSatisfying(versions, "^3")).toBeUndefined();
    expect(maxSatisfying(versions, "not a range")).toBeUndefined();
  });
});
