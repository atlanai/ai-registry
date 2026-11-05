import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BUN_VERSION } from "#packaging/targets.ts";
import { allowed, bunLicense } from "./generate.ts";

describe("third-party notices", () => {
  test("allows a listed license, or an OR with one listed side", () => {
    expect(allowed("MIT")).toBe(true);
    expect(allowed("(MIT OR CC0-1.0)")).toBe(true);
    expect(allowed("(GPL-3.0-only OR MIT)")).toBe(true);
  });

  test("refuses anything else, including AND, WITH and nesting", () => {
    expect(allowed("LGPL-2.1-only")).toBe(false);
    expect(allowed("UNKNOWN")).toBe(false);
    expect(allowed("MIT AND GPL-2.0-only")).toBe(false);
    expect(allowed("Apache-2.0 WITH LLVM-exception")).toBe(false);
    expect(allowed("(MIT OR (GPL-2.0-only AND BSD-3-Clause))")).toBe(false);
  });

  test("vendors Bun's license from the version release builds pin", () => {
    const vendored = readFileSync(
      join(import.meta.dirname, "..", "..", "packaging", "licenses", "bun.md"),
      "utf8",
    );
    expect(bunLicense(vendored)).toMatch(/^Bun itself is MIT-licensed\./);
    expect(() => bunLicense(vendored, `${BUN_VERSION}0`)).toThrow(/vendor its LICENSE\.md/);
  });
});
