import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { Printer } from "#core/output.ts";
import type { ArtifactStatus } from "#core/plan/status.ts";
import { withoutKind } from "#test/kit/harness.ts";
import type { Installed } from "./installed.ts";
import { renderStatus } from "./status.ts";

const chosen = {
  harnesses: resolveHarnesses({ HOME: "/home/dev" }),
  for: () => ["claude", "codex"],
};

function rendered(statuses: ArtifactStatus[], rows: Installed[], harnesses = chosen.harnesses) {
  const lines: string[] = [];
  const sink = { write: (chunk: string) => lines.push(chunk.trimEnd()), isTTY: false };
  const printer = new Printer({ out: sink, err: sink, color: "never" });
  renderStatus(printer, statuses, rows, "project", { ...chosen, harnesses });
  return lines;
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
  it("shows a watched artifact under the harness whose folder it is", () => {
    const watched = { harness: "claude", path: "~/.claude/skills/lint" };
    const lines = rendered(
      [{ name: "lint", state: "ok", detail: undefined, harnesses: {} }],
      [row("lint", "skill", { watched })],
    );
    expect(lines).toContain("  artifact  kind   version  from  Claude Code  state");
    expect(lines).toContain("  lint      skill  0.1.0    acme  watched      ok");
  });

  it("has a column per chosen harness, filled from the folder each one reads", () => {
    const lines = rendered(
      [
        {
          name: "pr-review",
          state: "ok",
          detail: undefined,
          harnesses: { agents: "linked", claude: "linked" },
        },
        { name: "reviewer", state: "missing", detail: undefined, harnesses: { claude: "missing" } },
      ],
      [row("pr-review", "skill"), row("reviewer", "agent")],
    );
    expect(lines).toContain("  artifact   kind   version  from  Claude Code  Codex  state");
    expect(lines).toContain("  pr-review  skill  0.1.0    acme  ✓            ✓      ok");
    expect(lines).toContain("  reviewer   agent  0.1.0    acme  missing      -      missing");
  });

  it("says replaced, drops the folder from a detail, and explains each dash and ok", () => {
    const lines = rendered(
      [
        {
          name: "pr-review",
          state: "dangling",
          detail: "claude: replaced by something of yours",
          harnesses: { agents: "linked", claude: "replaced" },
        },
        { name: "reviewer", state: "ok", detail: undefined, harnesses: { claude: "linked" } },
      ],
      [row("pr-review", "skill"), row("reviewer", "agent")],
      withoutKind(chosen.harnesses, "codex", "agent"),
    );
    expect(lines).toContain(
      "  pr-review  skill  0.1.0    acme  replaced     ✓      replaced  replaced by something of yours",
    );
    expect(lines).toContain("Codex skips reviewer: it does not load agents.");
    expect(lines).toContain("ok  matches the lockfile, links intact");
    expect(lines).toContain("1 artifact needs attention.");
  });
  it("points an edit to a file aireg writes for a harness at install --force, not sync", () => {
    const edited = (name: string, folder: string) => ({
      name,
      state: "edited" as const,
      detail: `${folder}: its copy was edited after installation`,
      harnesses: { [folder]: "linked" as const },
    });
    const only = rendered([edited("reviewer", "codex")], [row("reviewer", "agent")]);
    expect(only).toContain(
      "hint: Codex reads a copy aireg writes from the agent: run `aireg install --force` to write it again, and change the agent in its registry.",
    );
    const both = rendered(
      [edited("reviewer", "codex"), edited("lint", "claude")],
      [row("reviewer", "agent"), row("lint", "skill")],
    );
    expect(both.join("\n")).toContain("Run `aireg sync` to compare the edits with the registry.");
  });
});
