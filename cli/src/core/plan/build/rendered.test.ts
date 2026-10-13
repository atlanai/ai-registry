import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import type { Action } from "#core/plan/model.ts";
import { roots } from "#core/store/paths.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS, wrapping } from "#test/kit/builders/plan.ts";

const REVIEWER = entry({ name: "reviewer", kind: "agent", path: "agents/reviewer.md" });

function links(scope: "project" | "user", copy = false, wrapped = false) {
  const plan = build(
    kitManifest(["kit/agent/reviewer"]),
    emptyLock(),
    (wrapped ? wrapping : (sources: ReturnType<typeof acquired>) => sources)(
      acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]])),
    ),
    { artifacts: {} },
    { ...PLAN_OPTIONS, roots: roots(scope, "/work"), targets: ["claude", "codex"], copy },
  );
  return plan.actions.flatMap((action: Action) =>
    action.kind === "link"
      ? [
          {
            harness: action.harness,
            to: relative("/work", action.to),
            copy: action.copy,
            render: action.render,
          },
        ]
      : [],
  );
}

describe("an agent for a harness that reads its own format", () => {
  it("is written as a real file, beside the link another harness takes", () => {
    expect(links("project")).toEqual([
      { harness: "claude", to: ".claude/agents/reviewer.md", copy: false, render: undefined },
      {
        harness: "codex",
        to: ".codex/agents/reviewer.toml",
        copy: true,
        render: {
          format: "toml",
          fields: ["name", "description"],
          body: "developer_instructions",
        },
      },
    ]);
  });

  it("goes to the harness's user folder in your user scope, as a file even under --copy", () => {
    const codex = links("user", true).find((link) => link.harness === "codex");
    expect(codex?.to).toMatch(/agents\/reviewer\.toml$/);
    expect(codex?.copy).toBe(true);
  });

  it("is written on its own even where its namespace becomes a Codex plugin", () => {
    const codex = links("user", false, true).filter((link) => link.harness === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]?.to).toMatch(/agents\/reviewer\.toml$/);
  });
});
