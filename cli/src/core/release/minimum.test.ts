import { describe, expect, test } from "vitest";
import { needsMinimumUpdate } from "./minimum.ts";

describe("needsMinimumUpdate", () => {
  test("asks for an update only below the floor", () => {
    expect(needsMinimumUpdate("0.1.0", undefined)).toBe(false);
    expect(needsMinimumUpdate("0.1.0", "0.1.0")).toBe(false);
    expect(needsMinimumUpdate("0.1.1", "0.1.0")).toBe(false);
    expect(needsMinimumUpdate("0.0.9", "0.1.0")).toBe(true);
  });
});
