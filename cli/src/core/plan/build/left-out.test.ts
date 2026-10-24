import { describe, expect } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import type { Placement } from "#core/plan/model.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";

const HELPER = "agents/helper.md";

function withLeftOut(files: string[]) {
  const sources = acquired(
    [entry({ name: "helper", kind: "agent", path: HELPER, from: { file: HELPER, pointer: "" } })],
    "c1",
    new Map([[HELPER, "sha256:t1"]]),
  );
  const placement = sources[0]?.placements.get(HELPER) as Placement;
  placement.leftOut = { entry: "AGENT.md", files };
  return sources;
}

describe("a version holding more files than it installs as", () => {
  test("warns of the files left out, naming the first few", () => {
    const manifest = kitManifest(["kit/agent/helper"]);
    const one = build(
      manifest,
      emptyLock(),
      withLeftOut(["notes.md"]),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(one.warnings).toEqual([
      {
        name: "helper",
        message:
          "helper installs as its AGENT.md alone, since a harness takes an agent as one file, so notes.md is left out.",
      },
    ]);
    const many = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"];
    const plan = build(manifest, emptyLock(), withLeftOut(many), { artifacts: {} }, PLAN_OPTIONS);
    expect(plan.warnings.map((warning) => warning.message)).toEqual([
      "helper installs as its AGENT.md alone, since a harness takes an agent as one file, so a.md, b.md, c.md, d.md, e.md and 2 more files are left out.",
    ]);
  });
});
