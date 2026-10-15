import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "./index.ts";

describe("resolveHarnesses", () => {
  it("expands each user root against HOME", () => {
    expect(resolveHarnesses({ HOME: "/home/u" }).claude?.userRoot).toBe(join("/home/u", ".claude"));
  });

  it("fills the defaults an entry leaves out", () => {
    const table = resolveHarnesses();
    expect(table.cursor?.detect).toEqual({ env: [], binary: ["cursor"], paths: [] });
    expect(table.claude?.reads).toEqual({});
    expect(table.claude?.shared).toBe(false);
  });
});
