import { describe, expect, test } from "vitest";
import { emptyLock } from "#core/lock.ts";
import type { Acquired } from "#core/plan/model.ts";
import { parseRef } from "#core/ref.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { build } from "./build.ts";

describe("dependencies", () => {
  test("land in the targets their dependent was narrowed to", () => {
    const reviewer = "artifacts/eng/agent/reviewer.md";
    const lint = "artifacts/eng/skill/lint";
    const [source] = acquired([
      entry({ name: "reviewer", kind: "agent", path: reviewer, group: "eng" }),
      entry({ name: "lint", path: lint, group: "eng" }),
    ]) as [Acquired];
    const need = { namespace: "eng", kind: "skill" as const, name: "lint", version: "1.0.0" };
    source.placements.set(reviewer, {
      id: reviewer,
      name: "reviewer",
      contentId: "sha256:r",
      version: "0.3.0",
      needs: [need],
    });
    source.placements.set(lint, {
      id: lint,
      name: "lint",
      contentId: "sha256:l",
      version: "1.0.0",
    });
    const wanted = kitManifest([]);
    wanted.artifacts = [{ ...parseRef("kit/eng/agent/reviewer"), targets: ["claude-code"] }];

    const plan = build(
      wanted,
      emptyLock(),
      [source],
      { artifacts: {} },
      {
        ...PLAN_OPTIONS,
        targets: ["claude-code", "codex"],
      },
    );
    const into = plan.actions.flatMap((action) =>
      action.kind === "link" && action.name === "lint" ? [action.target] : [],
    );
    expect(into).toEqual(["claude-code"]);
    expect(plan.neededBy).toEqual({ lint: ["reviewer"] });
  });
});
