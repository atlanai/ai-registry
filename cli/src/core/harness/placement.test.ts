import { describe, expect, it } from "vitest";
import { placementFor, readsFor, resolveHarnesses } from "./index.ts";

describe("placementFor", () => {
  const harnesses = resolveHarnesses({ HOME: "/tmp/home" });
  const place = (
    kind: "skill" | "agent",
    selected: string[],
    scope: "project" | "user" = "project",
  ) => placementFor(kind, selected, harnesses, scope);

  it.each([
    [["claude"], ["claude"]],
    [["codex"], ["agents"]],
    [
      ["claude", "codex"],
      ["agents", "claude"],
    ],
    [["claude", "cursor"], ["claude"]],
    [["codex", "cursor"], ["agents"]],
    [["cursor"], ["agents"]],
  ])("writes skills for %j to %j", (selected, targets) => {
    expect(place("skill", selected)).toEqual({ targets, unreadable: [] });
  });

  it("places an agent in each tool's own folder", () => {
    expect(place("agent", ["claude", "codex"])).toEqual({
      targets: ["claude", "codex"],
      unreadable: [],
    });
  });

  it("places a shared folder once when it is selected by name", () => {
    expect(place("skill", ["agents", "codex"]).targets).toEqual(["agents"]);
  });

  it("ignores names it does not know and repeats it was given", () => {
    expect(place("skill", ["claude", "claude", "missing"]).targets).toEqual(["claude"]);
  });
});

describe("built-in reads", () => {
  it("marks the shared folder as not a tool", () => {
    const table = resolveHarnesses();
    expect(table.agents?.shared).toBe(true);
    expect(table.agents?.detect).toBe("never");
    expect(table.claude?.shared).toBe(false);
  });

  it("defaults a tool with no reads to its own folder", () => {
    const table = resolveHarnesses();
    expect(readsFor(table, "claude", "skill")).toEqual(["claude"]);
    expect(readsFor(table, "codex", "agent")).toEqual(["codex"]);
  });

  it("reads Cursor's skills from the Codex folder too", () => {
    const table = resolveHarnesses();
    expect(readsFor(table, "cursor", "skill")).toEqual(["agents", "cursor", "claude", "codex"]);
  });
});
