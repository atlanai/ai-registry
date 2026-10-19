import { describe, expect, it } from "vitest";
import { engineFromUnknown, olderThan, parseEngine, unmetEngine } from "#core/semver.ts";

describe("engines.aireg", () => {
  it("accepts an optional >= prefix and refuses a range", () => {
    expect(parseEngine(">=0.3.0")).toBe("0.3.0");
    expect(parseEngine("0.3.0")).toBe("0.3.0");
    expect(parseEngine(">=v0.3.0")).toBe("0.3.0");
    expect(parseEngine("^0.3.0")).toBeUndefined();
    expect(parseEngine("0.3.0-beta")).toBeUndefined();
    expect(engineFromUnknown(3)).toBeUndefined();
    expect(engineFromUnknown({ aireg: "0.5.0" })).toBe("0.5.0");
    expect(engineFromUnknown({ registry: "0.4.0" })).toBeUndefined();
  });

  it("explains when the running CLI is too old", () => {
    expect(unmetEngine("0.1.0", undefined)).toBeUndefined();
    expect(unmetEngine("0.2.0", "0.2.0")).toBeUndefined();
    expect(unmetEngine("0.1.0", "0.2.0")).toBe("needs aireg 0.2.0 or later; this CLI is 0.1.0");
  });
});

describe("olderThan", () => {
  it("is true only for a version strictly older than another", () => {
    expect(olderThan("0.1.0", "0.2.0")).toBe(true);
    expect(olderThan("0.2.0", "0.2.0")).toBe(false);
    expect(olderThan("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(olderThan(undefined, "0.2.0")).toBe(false);
    expect(olderThan("sha256:abc", "0.2.0")).toBe(false);
  });
});
