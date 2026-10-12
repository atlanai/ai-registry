import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { Printer } from "#core/output.ts";
import type { ArtifactStatus } from "#core/plan/status.ts";
import type { Installed } from "./installed.ts";
import { renderStatus } from "./status.ts";

const chosen = {
  harnesses: resolveHarnesses({ HOME: "/home/dev" }),
  for: () => ["claude", "codex"],
};

function rendered(statuses: ArtifactStatus[], rows: Installed[]): string[] {
  const lines: string[] = [];
  const sink = { write: (chunk: string) => lines.push(chunk.trimEnd()), isTTY: false };
  const printer = new Printer({ out: sink, err: sink, color: "never" });
  renderStatus(printer, statuses, rows, "project", chosen);
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
    );
    expect(lines).toContain(
      "  pr-review  skill  0.1.0    acme  replaced     ✓      replaced  replaced by something of yours",
    );
    expect(lines).toContain("Codex skips reviewer: it does not load agents.");
    expect(lines).toContain("ok  matches the lockfile, links intact");
    expect(lines).toContain("1 artifact needs attention.");
  });
});
