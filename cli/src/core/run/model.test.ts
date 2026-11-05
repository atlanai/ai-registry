import { expect, test } from "vitest";
import { addCounts, isRunPhase } from "./model.ts";

test("knows the phases a sync run reports, and nothing else", () => {
  expect(isRunPhase("classifying")).toBe(true);
  expect(isRunPhase("downloading")).toBe(false);
  expect(isRunPhase(undefined)).toBe(false);
});

test("adds two runs' counts field by field", () => {
  const a = { examined: 3, changed: 1, skipped: 1, attention: 1, failed: 0 };
  const b = { examined: 2, changed: 0, skipped: 0, attention: 1, failed: 1 };
  expect(addCounts(a, b)).toEqual({ examined: 5, changed: 1, skipped: 1, attention: 2, failed: 1 });
});
