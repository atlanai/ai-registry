import { describe, expect, it } from "vitest";
import type { Plan } from "#core/plan/model.ts";
import { narrowToRelinks } from "./relink.ts";

const plan = (actions: unknown[]) =>
  ({ actions, unchanged: [], warnings: [], incompatible: [] }) as unknown as Plan;

describe("narrowToRelinks", () => {
  it("keeps only a relinked artifact's link and unlink actions, and other artifacts whole", () => {
    const kept = narrowToRelinks(
      plan([
        { kind: "stage", name: "moved", source: "acme", path: "p", to: "t" },
        { kind: "link", name: "moved", target: "claude-code", from: "f", to: "new", copy: false },
        { kind: "unlink", name: "moved", to: "old" },
        { kind: "stage", name: "other", source: "acme", path: "p", to: "t" },
      ]),
      new Set(["moved"]),
    ).actions.map((action) =>
      action.kind === "record" ? "record" : `${action.kind}:${action.name}`,
    );
    expect(kept).toEqual(["link:moved", "unlink:moved", "stage:other"]);
  });
});
