import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalId, canonicalIds, earlierId, resolveTargets } from "./index.ts";

describe("resolveTargets", () => {
  it("expands each user root against HOME", () => {
    expect(resolveTargets({ HOME: "/home/u" })["claude-code"]?.userRoot).toBe(
      join("/home/u", ".claude"),
    );
  });

  it("fills the defaults an entry leaves out", () => {
    const table = resolveTargets();
    expect(table.cursor?.detect).toEqual({
      env: [],
      binary: ["cursor", "cursor-agent"],
      paths: [],
    });
    expect(table["claude-code"]?.reads).toEqual({});
    expect(table["claude-code"]?.shared).toBe(false);
  });

  it("keys each built-in by its industry id, with its earlier id as an alias", () => {
    const table = resolveTargets();
    expect(
      Object.fromEntries(Object.values(table).map((each) => [each.name, each.aliases])),
    ).toEqual({
      "claude-code": ["claude"],
      codex: [],
      cursor: [],
      "github-copilot": ["copilot"],
      "gemini-cli": ["gemini"],
      opencode: [],
      universal: ["agents"],
    });
  });
});

describe("earlierId", () => {
  it.each([
    ["claude-code", "claude"],
    ["github-copilot", "copilot"],
    ["gemini-cli", "gemini"],
    ["universal", "agents"],
    ["codex", "codex"],
    ["claude-code:work", "claude:work"],
    ["mine", "mine"],
  ])("records %s as %s, the id aireg 0.1 reads", (id, was) => {
    expect(earlierId(id)).toBe(was);
  });
});

describe("canonicalId", () => {
  const table = resolveTargets();

  it.each([
    ["claude", "claude-code"],
    ["claude-code", "claude-code"],
    ["copilot", "github-copilot"],
    ["gemini", "gemini-cli"],
    ["agents", "universal"],
    ["codex", "codex"],
    ["claude:work", "claude-code:work"],
    ["ghost", "ghost"],
    ["*", "*"],
  ])("reads %s as %s", (id, canonical) => {
    expect(canonicalId(table, id)).toBe(canonical);
  });

  it("names each target once, in the order given", () => {
    expect(canonicalIds(table, ["claude", "codex", "claude-code"])).toEqual([
      "claude-code",
      "codex",
    ]);
  });
});
