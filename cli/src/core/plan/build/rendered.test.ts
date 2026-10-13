import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import { roots } from "#core/store/paths.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS, wrapping } from "#test/kit/builders/plan.ts";

const REVIEWER = entry({ name: "reviewer", kind: "agent", path: "agents/reviewer.md" });

describe("an agent for a harness that reads its own format", () => {
  it("is written on its own even where its namespace becomes a Codex plugin", () => {
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, roots: roots("user", "/work"), targets: ["claude", "codex"] },
    );
    const codex = plan.actions.flatMap((action) =>
      action.kind === "link" && action.harness === "codex" ? [relative("/work", action.to)] : [],
    );
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatch(/agents\/reviewer\.toml$/);
  });
});
