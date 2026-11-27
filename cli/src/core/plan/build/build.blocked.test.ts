import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acquired,
  entry,
  installed,
  kitManifest,
  LINT,
  linksTo,
  PLAN_OPTIONS,
} from "#test/kit/builders/plan.ts";
import { build } from "./build.ts";

describe("a placement the last run kept back", () => {
  test("is tried again, so the run reports it until it lands", () => {
    const lock = installed();
    const row = lock.artifacts.lint;
    if (row === undefined) throw new Error("no lint row");
    row.links = [{ target: "claude-code", path: ".claude/skills/lint", mode: "copy" }];
    row.blocked = [{ target: "claude-code", path: ".claude/skills/lint" }];
    // Something of a person's stands where the copy would go.
    const survey = {
      artifacts: {
        lint: {
          ...LINT,
          links: {
            ".claude/skills/lint": {
              present: true,
              isLink: false,
              target: undefined,
              mode: "copy" as const,
            },
          },
        },
      },
    };
    const options = { ...PLAN_OPTIONS, copy: true };
    const plan = build(kitManifest(), lock, acquired([entry()]), survey, options);
    expect(linksTo(plan.actions, "claude-code")).toEqual([
      join("/work", ".claude", "skills", "lint"),
    ]);
  });
});
