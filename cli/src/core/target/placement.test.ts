import { describe, expect, it } from "vitest";
import { placementFor, readsFor, resolveTargets } from "./index.ts";

describe("placementFor", () => {
  const targetTable = resolveTargets({ HOME: "/tmp/home" });
  const place = (
    kind: "skill" | "agent",
    selected: string[],
    scope: "project" | "user" = "project",
  ) => placementFor(kind, selected, targetTable, scope);

  it.each([
    [["claude-code"], ["claude-code"]],
    [["codex"], ["universal"]],
    [
      ["claude-code", "codex"],
      ["claude-code", "universal"],
    ],
    [["claude-code", "cursor"], ["claude-code"]],
    [["codex", "cursor"], ["universal"]],
    [["cursor"], ["universal"]],
  ])("writes skills for %j to %j", (selected, targets) => {
    expect(place("skill", selected)).toEqual({ targets, unreadable: [] });
  });

  it("places an agent in each tool's own folder", () => {
    expect(place("agent", ["claude-code", "codex"])).toEqual({
      targets: ["claude-code", "codex"],
      unreadable: [],
    });
  });

  it("places a shared folder once when it is selected by name", () => {
    expect(place("skill", ["universal", "codex"]).targets).toEqual(["universal"]);
  });

  it("ignores names it does not know and repeats it was given", () => {
    expect(place("skill", ["claude-code", "claude-code", "missing"]).targets).toEqual([
      "claude-code",
    ]);
  });
});

describe("built-in reads", () => {
  it("marks the shared folder as not a tool", () => {
    const table = resolveTargets();
    expect(table.universal?.shared).toBe(true);
    expect(table.universal?.detect).toBe("never");
  });

  it("defaults a tool with no reads to its own folder", () => {
    const table = resolveTargets();
    expect(readsFor(table, "claude-code", "skill")).toEqual(["claude-code"]);
    expect(readsFor(table, "codex", "agent")).toEqual(["codex"]);
  });

  it("reads Cursor's skills from the Codex folder too", () => {
    const table = resolveTargets();
    expect(readsFor(table, "cursor", "skill")).toEqual([
      "universal",
      "cursor",
      "claude-code",
      "codex",
    ]);
  });
});
