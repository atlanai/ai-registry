import { describe, expect, test } from "vitest";
import { CLI_CODES } from "./codes.ts";

describe("CLI_CODES", () => {
  // Scripts branch on these codes, so each is distinct and keeps one shape.
  test("mints a distinct, non-empty code for every client failure", () => {
    expect(CLI_CODES.length).toBeGreaterThan(0);
    expect(new Set(CLI_CODES).size).toBe(CLI_CODES.length);
    for (const code of CLI_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
