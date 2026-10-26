import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTargets } from "./index.ts";

describe("resolveTargets", () => {
  it("expands each user root against HOME", () => {
    expect(resolveTargets({ HOME: "/home/u" }).claude?.userRoot).toBe(join("/home/u", ".claude"));
  });

  it("fills the defaults an entry leaves out", () => {
    const table = resolveTargets();
    expect(table.cursor?.detect).toEqual({
      env: [],
      binary: ["cursor", "cursor-agent"],
      paths: [],
    });
    expect(table.claude?.reads).toEqual({});
    expect(table.claude?.shared).toBe(false);
  });
});
