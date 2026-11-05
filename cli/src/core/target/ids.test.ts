import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import type { Target } from "./contract.ts";
import { canonicalId, canonicalIds, categoryOfEarlier, earlierId, earlierTable } from "./ids.ts";
import { resolveTargets } from "./table.ts";

/** The built-ins aireg 0.1 knew by another id; every other built-in kept its id. */
const EARLIER: Record<string, string> = {
  "claude-code": "claude",
  "github-copilot": "copilot",
  "gemini-cli": "gemini",
  universal: "agents",
};

describe("resolveTargets", () => {
  test("expands each user root against HOME", () => {
    expect(resolveTargets({ HOME: "/home/u" })["claude-code"]?.userRoot).toBe(
      join("/home/u", ".claude"),
    );
  });

  test("fills the defaults an entry leaves out", () => {
    const table = resolveTargets(process.env);
    expect(table.cursor?.detect).toEqual({
      env: [],
      binary: ["cursor", "cursor-agent"],
      paths: [],
    });
    expect(table["claude-code"]?.reads).toEqual({});
    expect(table["claude-code"]?.shared).toBe(false);
  });

  test("files every built-in as a coding agent but the shared folder", () => {
    const table = resolveTargets(process.env);
    const others = Object.values(table).filter((target) => target.category !== "coding-agent");
    expect(others.map(({ name, category, shared }) => [name, category, shared])).toEqual([
      ["universal", "shared-folder", true],
    ]);
  });

  test("keys each built-in by its industry id, with its earlier id as an alias", () => {
    const table = resolveTargets(process.env);
    expect(
      Object.fromEntries(Object.values(table).map((each) => [each.name, each.aliases])),
    ).toEqual(
      Object.fromEntries(
        BUILTIN_TARGETS.map(({ id }) => [id, EARLIER[id] === undefined ? [] : [EARLIER[id]]]),
      ),
    );
  });
});

describe("earlierId", () => {
  test.each([
    ["claude-code", "claude"],
    ["github-copilot", "copilot"],
    ["gemini-cli", "gemini"],
    ["universal", "agents"],
    ["codex", "codex"],
    ["claude-code:work", "claude:work"],
    ["mine", "mine"],
  ])("records %s as %s, the id aireg 0.1 reads", (id, was) => {
    expect(earlierId(resolveTargets(process.env), id)).toBe(was);
  });

  test("keeps today's id once the table no longer reads the earlier one as this target", () => {
    const table = resolveTargets(process.env);
    const renamed = {
      ...table,
      "claude-code": { ...(table["claude-code"] as Target), aliases: ["cc"] },
    };
    expect(earlierId(renamed, "claude-code")).toBe("claude-code");
    expect(earlierId(renamed, "claude-code:work")).toBe("claude-code:work");
    const taken = { ...renamed, codex: { ...(table.codex as Target), aliases: ["claude"] } };
    expect(earlierId(taken, "claude-code")).toBe("claude-code");
  });
});

describe("earlierTable", () => {
  test("keys and names each target by the id aireg 0.1 knew, with its kind", () => {
    const table = earlierTable(resolveTargets(process.env));
    const claude = Object.values(table).find((target) => target.name === "claude");
    expect(claude?.displayName).toBe("Claude Code");
    expect(Object.keys(table).sort()).toEqual(
      BUILTIN_TARGETS.map(({ id }) => EARLIER[id] ?? id).sort(),
    );
    expect(table.agents?.kind).toBe("shared");
    expect(table.codex?.reads).toEqual({ skill: ["agents"] });
    expect(table.opencode?.reads).toEqual({ skill: ["agents", "opencode", "claude"] });
    expect(table.codex?.kind).toBe("coding");
    const helper = {
      ...(table.codex as Target),
      name: "helper",
      category: "personal-agent" as const,
    };
    expect(earlierTable({ helper }).helper?.kind).toBe("personal");
  });

  test("leaves an earlier id to a target that has it as its own", () => {
    const table = resolveTargets(process.env);
    const mine = { ...(table.codex as Target), name: "claude", displayName: "Mine" };
    expect(earlierTable({ ...table, claude: mine }).claude?.displayName).toBe("Mine");
  });
});

describe("canonicalId", () => {
  const table = resolveTargets(process.env);

  test.each([
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

  test("names each target once, in the order given", () => {
    expect(canonicalIds(table, ["claude", "codex", "claude-code"])).toEqual([
      "claude-code",
      "codex",
    ]);
  });
});

test("reads aireg 0.1's kind as the category that replaced it", () => {
  expect(categoryOfEarlier("personal")).toBe("personal-agent");
  expect(categoryOfEarlier("coding-agent")).toBeUndefined();
});
