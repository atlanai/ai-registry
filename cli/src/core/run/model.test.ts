import { expect, test } from "vitest";
import { isRunPhase } from "./model.ts";

test("knows the phases a sync run reports, and nothing else", () => {
  expect(isRunPhase("classifying")).toBe(true);
  expect(isRunPhase("downloading")).toBe(false);
  expect(isRunPhase(undefined)).toBe(false);
});
