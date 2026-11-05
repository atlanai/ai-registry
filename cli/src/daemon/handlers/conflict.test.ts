import { describe, expect, test } from "vitest";
import { resolvable } from "./conflict.ts";

describe("resolvable", () => {
  test("takes the registry's copy over an edit, and publishes only an edit", () => {
    const edited = { operation: "report", disposition: "publish" } as const;
    const moved = { operation: "pull", disposition: "pull" } as const;
    const settled = { operation: "none", disposition: "synced" } as const;
    expect(resolvable(edited, "theirs")).toBe(true);
    expect(resolvable(edited, "mine")).toBe(true);
    expect(resolvable(moved, "mine")).toBe(false);
    expect(resolvable(settled, "theirs")).toBe(false);
    expect(resolvable(undefined, "theirs")).toBe(false);
    expect(resolvable({ operation: "attention", disposition: "conflict" }, "mine")).toBe(true);
  });
});
