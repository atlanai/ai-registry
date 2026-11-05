import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Lock } from "#core/lock.ts";
import type { ApplyResult } from "#core/plan/apply/run.ts";
import type { Action } from "#core/plan/model.ts";
import { resolveTargets } from "#core/target/table.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { capturedPrinter } from "#test/kit/printer.ts";
import { planReport, summarize } from "./plan.ts";

function printed(
  actions: Action[],
  applied: Partial<ApplyResult>,
  before: Record<string, unknown> = {},
  targets: string[] = ["claude-code", "codex"],
  targetTable = resolveTargets({ HOME: "/home/dev" }),
): string[] {
  const lines: string[] = [];
  const { printer } = capturedPrinter({ printed: lines, errors: lines });
  const result = {
    performed: {},
    installed: [],
    added: [],
    removed: [],
    kept: [],
    carried: [],
    unrendered: [],
    ...applied,
  } as unknown as ApplyResult;
  summarize(printer, {
    plan: { ...emptyPlan(), actions },
    applied: result,
    before: { artifacts: before, registries: {} } as unknown as Lock,
    targets,
    targetTable,
    scope: "project",
  });
  return lines.map((line) => line.trimEnd());
}

const link = (name: string, target: string) =>
  ({ kind: "link", name, target, from: "f", to: `t/${target}/${name}`, copy: false }) as Action;

const at = (target: string) => ({ target, path: "p", mode: "symlink" });

describe("summarize", () => {
  test("names the tools that load what was installed, not the folders or the steps", () => {
    const actions = [link("lint", "claude-code"), link("lint", "universal")];
    const lock = {
      artifacts: { lint: { kind: "skill", links: [at("claude-code"), at("universal")] } },
    };
    const applied = {
      performed: { link: 2 } as never,
      installed: ["lint"],
      added: ["lint"],
      lock: lock as never,
    };
    // Codex reads skills from `.agents`.
    expect(printed(actions, applied)).toEqual(["✓ Installed lint for Claude Code and Codex."]);
  });

  test("names a shared folder by its path when no chosen tool reads it", () => {
    const actions = [link("lint", "universal")];
    const lock = { artifacts: { lint: { kind: "skill", links: [at("universal")] } } };
    const applied = {
      performed: { link: 1 } as never,
      installed: ["lint"],
      added: ["lint"],
      lock: lock as never,
    };
    expect(printed(actions, applied, {}, ["universal"])).toEqual(["✓ Installed lint for .agents."]);
  });

  test("names the tool whose own folder in a project is the shared folder", () => {
    const actions = [link("lint", "universal")];
    const lock = { artifacts: { lint: { kind: "skill", links: [at("universal")] } } };
    const applied = {
      performed: { link: 1 } as never,
      installed: ["lint"],
      added: ["lint"],
      lock: lock as never,
    };
    expect(printed(actions, applied, {}, ["antigravity"])).toEqual([
      "✓ Installed lint for Google Antigravity.",
      "hint: Start a new conversation in Antigravity, or run `/skills reload` in its CLI, to load the change.",
    ]);
  });

  test("names every member of a new namespace as installed, though one link carries them", () => {
    const clone = (name: string) => ({ kind: "clone", name, from: "f", to: `c/${name}` }) as Action;
    const row = (target: string) => ({ links: [{ target, path: "p", mode: "symlink" }] });
    const lock = {
      artifacts: { add: row("claude-code"), new: row("claude-code"), publish: row("claude-code") },
    };
    const actions = [link("add", "claude-code"), clone("add"), clone("new"), clone("publish")];
    const applied = {
      performed: { link: 1, clone: 3 } as never,
      installed: ["add"],
      added: ["add", "new", "publish"],
      lock: lock as never,
    };
    expect(printed(actions, applied, {}, ["claude-code"])).toEqual([
      "✓ Installed add, new and publish for Claude Code.",
    ]);
  });

  test("says which targets start a plugin's hooks and MCP servers", () => {
    const actions = [link("tools", "claude-code"), link("tools", "codex")];
    const applied = {
      performed: { link: 2 } as never,
      installed: ["tools"],
      added: ["tools"],
      carried: [{ name: "tools", carries: ["hooks", "mcpServers"] }] as ApplyResult["carried"],
    };
    expect(printed(actions, applied)).toEqual([
      "✓ Installed tools for Claude Code and Codex.",
      "  runs   hooks and MCP servers from tools, in Claude Code and Codex",
    ]);
  });

  test("says once what a target asks of a person before it loads what was placed", () => {
    const targetTable = resolveTargets({ HOME: "/home/dev" });
    targetTable["claude-code"] = {
      ...targetTable["claude-code"]!,
      trust: { skill: { run: "tool trust" }, agent: { run: "tool trust --agents", scope: "user" } },
      reload: "Run `/reload` in Claude Code.",
    };
    const lock = {
      artifacts: {
        lint: { kind: "skill", links: [at("claude-code")] },
        fmt: { kind: "skill", links: [at("claude-code")] },
        reviewer: { kind: "agent", links: [at("claude-code")] },
      },
    };
    const actions = [
      link("lint", "claude-code"),
      link("fmt", "claude-code"),
      link("reviewer", "claude-code"),
    ];
    const applied = {
      performed: { link: 3 } as never,
      installed: ["lint", "fmt", "reviewer"],
      added: ["lint", "fmt", "reviewer"],
      lock: lock as never,
    };
    expect(printed(actions, applied, {}, ["claude-code"], targetTable)).toEqual([
      "✓ Installed lint, fmt and reviewer for Claude Code.",
      "hint: Claude Code loads skills here only once you trust them: run `tool trust`.",
      "hint: Run `/reload` in Claude Code.",
    ]);
  });

  test("names in one line every kind that waits on the same trust step", () => {
    const lock = {
      artifacts: {
        lint: { kind: "skill", links: [at("gemini-cli")] },
        reviewer: { kind: "agent", links: [at("gemini-cli")] },
      },
    };
    const applied = {
      performed: { link: 2 } as never,
      installed: ["lint", "reviewer"],
      added: ["lint", "reviewer"],
      lock: lock as never,
    };
    const lines = printed(
      [link("lint", "gemini-cli"), link("reviewer", "gemini-cli")],
      applied,
      {},
      ["gemini-cli"],
    );
    expect(lines.filter((line) => line.includes("trust"))).toEqual([
      "hint: Gemini CLI loads skills and agents here only once you trust them: run `/permissions trust`.",
    ]);
  });

  test("asks for the steps of a tool that reads the shared folder a skill went to", () => {
    const lock = { artifacts: { lint: { kind: "skill", links: [at("universal")] } } };
    const applied = {
      performed: { link: 1 } as never,
      installed: ["lint"],
      added: ["lint"],
      lock: lock as never,
    };
    // Grok Build and Codex both read skills from `.agents`.
    expect(printed([link("lint", "universal")], applied, {}, ["grok", "codex"])).toEqual([
      "✓ Installed lint for Grok Build and Codex.",
      "hint: Grok Build loads skills here only once you trust them: run `grok --trust`.",
      "hint: Start a new Grok Build session to load the change.",
    ]);
  });

  test("asks a tool that reads the shared folder a skill left to reload, not to trust", () => {
    const gone = [
      { kind: "unlink", name: "lint", to: "x", link: at("universal") } as unknown as Action,
    ];
    const before = { lint: { kind: "skill", links: [at("universal")] } };
    const applied = { performed: { unlink: 1 } as never, removed: ["lint"] };
    expect(printed(gone, applied, before, ["grok", "cursor"])).toEqual([
      "✓ Removed lint.",
      "hint: Start a new Grok Build session to load the change.",
      "hint: Restart Cursor, or run Developer: Reload Window, to load the change.",
    ]);
  });

  test("says a plugin's hooks run only where it installs whole, not where its skills went", () => {
    const actions = [
      { ...link("tools", "claude-code"), plugin: true } as Action,
      link("tools", "universal"),
    ];
    const lock = {
      artifacts: { tools: { kind: "plugin", links: [at("claude-code"), at("universal")] } },
    };
    const applied = {
      performed: { link: 2 } as never,
      installed: ["tools"],
      added: ["tools"],
      lock: lock as never,
      carried: [{ name: "tools", carries: ["hooks"] }] as ApplyResult["carried"],
    };
    expect(printed(actions, applied, {}, ["claude-code", "universal"])).toContain(
      "  runs   hooks from tools, in Claude Code",
    );
  });

  test("calls a new version of an installed artifact an update", () => {
    const actions = [
      { kind: "clone", name: "lint", from: "f", to: "c" } as Action,
      link("lint", "claude-code"),
    ];
    const applied = { performed: { link: 1, clone: 1 } as never, installed: ["lint"], added: [] };
    expect(printed(actions, applied)).toEqual(["✓ Updated lint."]);
  });

  test("says which version an update moved from and to", () => {
    const actions = [
      { kind: "clone", name: "lint", from: "f", to: "c" } as Action,
      link("lint", "claude-code"),
    ];
    const lock = { artifacts: { lint: { version: "0.2.0", links: [] } } };
    const applied = { performed: { link: 1, clone: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ target: "claude-code" }] } };
    expect(printed(actions, applied, before)).toEqual(["✓ Updated lint 0.1.0 → 0.2.0."]);
  });

  test("calls a link put back at the same version a restore, not an update", () => {
    const lock = { artifacts: { lint: { version: "0.1.0", links: [] } } };
    const applied = { performed: { link: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ target: "claude-code" }] } };
    expect(printed([link("lint", "claude-code")], applied, before)).toEqual([
      "✓ Restored lint for Claude Code.",
    ]);
  });

  test("calls content fetched and copied again at the same version a restore, not an update", () => {
    const actions = [
      { kind: "stage", name: "lint", source: "s", path: "p", to: "m" } as Action,
      { kind: "clone", name: "lint", from: "m", to: "c" } as Action,
    ];
    const lock = { artifacts: { lint: { version: "0.1.0", links: [] } } };
    const applied = { performed: { stage: 1, clone: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ target: "claude-code" }] } };
    expect(printed(actions, applied, before)).toEqual(["✓ Restored lint for Claude Code."]);
  });

  test("names a row of yours whose target links went as removed, though the row stays", () => {
    const gone = [{ kind: "unlink", name: "lint", to: "x" } as Action];
    const lock = { artifacts: { lint: { links: [] } } };
    const applied = { performed: { unlink: 1 } as never, removed: ["lint"], lock: lock as never };
    expect(printed(gone, applied)).toEqual(["✓ Removed lint."]);
  });

  test("names what was removed, and counts a long list", () => {
    const gone = ["a", "b", "c", "d"].map((name) => ({ kind: "unlink", name, to: "x" }) as Action);
    const applied = { performed: { unlink: 4 } as never, removed: ["a", "b", "c", "d"] };
    expect(printed(gone, applied)).toEqual(["✓ Removed 4 artifacts."]);
  });
});

describe("planReport", () => {
  const targetTable = resolveTargets({ HOME: "/home/dev" });
  const chosen = { targets: ["claude-code", "codex"], targetTable };
  const plan = {
    ...emptyPlan(),
    actions: [
      link("pr-review", "universal"),
      link("pr-review", "claude-code"),
      link("reviewer", "claude-code"),
      {
        kind: "record",
        lock: {
          artifacts: { "pr-review": { kind: "skill" }, reviewer: { kind: "agent" } },
          registries: {},
        },
      } as unknown as Action,
    ],
  };

  function report(verbose: boolean): string[] {
    const lines: string[] = [];
    const { printer } = capturedPrinter({ printed: lines, errors: lines, verbose });
    const shown = planReport(printer);
    shown.plan(plan, { scope: "project", base: process.cwd() } as never, new Set(), chosen);
    for (const action of plan.actions) shown.step(action, plan, chosen);
    return lines
      .map((line) => line.trimEnd())
      .join("\n")
      .split("\n");
  }

  test("names the targets each link is for, not the folder it is in", () => {
    const lines = report(false);
    expect(lines).toContain("  action   artifact   targets      path");
    expect(lines).toContain(
      `  install  pr-review  Codex        ${join("t", "universal", "pr-review")}`,
    );
    expect(lines).toContain(
      `  install  pr-review  Claude Code  ${join("t", "claude-code", "pr-review")}`,
    );
  });

  test("names them in each step a verbose run prints", () => {
    expect(report(true)).toContain("· install pr-review for Codex");
  });
});
