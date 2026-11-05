import { describe, expect, test } from "vitest";
import type { ArtifactStatus } from "#core/plan/status.ts";
import { resolveTargets } from "#core/target/table.ts";
import { capturedPrinter } from "#test/kit/printer.ts";
import { withoutKind } from "#test/kit/target.ts";
import type { Installed } from "./installed.ts";
import { renderStatus } from "./status.ts";

const chosen = {
  targetTable: resolveTargets({ HOME: "/home/dev" }),
  for: () => ["claude-code", "codex"],
};

function rendered(statuses: ArtifactStatus[], rows: Installed[], targetTable = chosen.targetTable) {
  const lines: string[] = [];
  const { printer } = capturedPrinter({ printed: lines, errors: lines });
  renderStatus(printer, statuses, rows, "project", { ...chosen, targetTable });
  return lines.map((line) => line.trimEnd());
}

const row = (name: string, kind: string, extra: Partial<Installed> = {}): Installed => ({
  name,
  shown: name,
  kind,
  registry: "acme",
  address: "",
  ref: "0.1.0",
  pinned: false,
  targets: [],
  ...extra,
});

describe("renderStatus", () => {
  test("shows a watched artifact under the target whose folder it is", () => {
    const watched = { target: "claude-code", harness: "claude", path: "~/.claude/skills/lint" };
    const lines = rendered(
      [{ name: "lint", state: "ok", detail: undefined, targets: {} }],
      [row("lint", "skill", { watched })],
    );
    expect(lines).toContain("  artifact  kind   version  from  Claude Code  state");
    expect(lines).toContain("  lint      skill  0.1.0    acme  watched      ok");
  });

  test("has a column per chosen target, filled from the folder each one reads", () => {
    const lines = rendered(
      [
        {
          name: "pr-review",
          state: "ok",
          detail: undefined,
          targets: { universal: "linked", "claude-code": "linked" },
        },
        {
          name: "reviewer",
          state: "missing",
          detail: undefined,
          targets: { "claude-code": "missing" },
        },
      ],
      [row("pr-review", "skill"), row("reviewer", "agent")],
    );
    expect(lines).toContain("  artifact   kind   version  from  Claude Code  Codex  state");
    expect(lines).toContain("  pr-review  skill  0.1.0    acme  ✓            ✓      ok");
    expect(lines).toContain("  reviewer   agent  0.1.0    acme  missing      -      missing");
  });

  test("says replaced, drops the folder from a detail, and explains each dash and ok", () => {
    const lines = rendered(
      [
        {
          name: "pr-review",
          state: "dangling",
          detail: "claude-code: replaced by something of yours",
          targets: { universal: "linked", "claude-code": "replaced" },
        },
        { name: "reviewer", state: "ok", detail: undefined, targets: { "claude-code": "linked" } },
      ],
      [row("pr-review", "skill"), row("reviewer", "agent")],
      withoutKind(chosen.targetTable, "codex", "agent"),
    );
    expect(lines).toContain(
      "  pr-review  skill  0.1.0    acme  replaced     ✓      replaced  replaced by something of yours",
    );
    expect(lines).toContain("Codex skips reviewer: it does not load agents.");
    expect(lines).toContain("ok  matches the lockfile, links intact");
    expect(lines).toContain("1 artifact needs attention.");
  });
  test("points an edit to a file aireg writes for a target at install --force, not sync", () => {
    const edited = (name: string, folder: string) => ({
      name,
      state: "edited" as const,
      detail: `${folder}: its copy was edited after installation`,
      targets: { [folder]: "linked" as const },
    });
    const only = rendered([edited("reviewer", "codex")], [row("reviewer", "agent")]);
    expect(only).toContain(
      "hint: Codex reads a copy aireg writes from the agent: run `aireg install --force` to write it again, and change the agent in its registry.",
    );
    const both = rendered(
      [edited("reviewer", "codex"), edited("lint", "claude-code")],
      [row("reviewer", "agent"), row("lint", "skill")],
    );
    expect(both.join("\n")).toContain("Run `aireg sync` to compare the edits with the registry.");
  });

  test("points an edit to a skill a target takes as a copy at install --force", () => {
    const claude = chosen.targetTable["claude-code"];
    const skill = claude?.kinds.skill;
    if (claude === undefined || skill?.shape !== "directory") throw new Error("no claude skill");
    const targetTable = {
      ...chosen.targetTable,
      "claude-code": {
        ...claude,
        kinds: { ...claude.kinds, skill: { ...skill, place: "copy" as const } },
      },
    };
    const lines = rendered(
      [
        {
          name: "lint",
          state: "edited",
          detail: "claude-code: its copy was edited after installation",
          targets: { "claude-code": "linked" },
        },
      ],
      [row("lint", "skill")],
      targetTable,
    );
    expect(lines).toContain(
      "hint: Claude Code reads a copy aireg writes from the skill: run `aireg install --force` to write it again, and change the skill in its registry.",
    );
  });
});
