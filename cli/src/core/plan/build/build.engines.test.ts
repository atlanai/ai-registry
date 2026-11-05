import { describe, expect, test } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { build } from "./build.ts";

describe("engines.aireg", () => {
  test("blocks an explicit artifact the running CLI is too old for", () => {
    const plan = build(
      kitManifest(["kit/skill/lint"]),
      emptyLock(),
      acquired([entry({ engine: "9.0.0" })]),
      { artifacts: {} },
      { ...PLAN_OPTIONS, cliVersion: "0.1.0" },
    );
    expect(plan.incompatible).toEqual([{ name: "lint", engine: "9.0.0" }]);
    expect(plan.actions.filter((action) => action.kind === "stage")).toEqual([]);
  });

  test("skips a too-new artifact in a whole-registry install, and warns", () => {
    const plan = build(
      kitManifest(["kit"]),
      emptyLock(),
      acquired([entry({ engine: "9.0.0" }), entry({ name: "review", path: "skills/review" })]),
      { artifacts: {} },
      { ...PLAN_OPTIONS, cliVersion: "0.1.0" },
    );
    expect(plan.incompatible).toEqual([]);
    expect(plan.warnings.some((warning) => warning.message.includes("9.0.0"))).toBe(true);
    expect(plan.actions.some((action) => action.kind === "stage" && action.name === "review")).toBe(
      true,
    );
  });
});
