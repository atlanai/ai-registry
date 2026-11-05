import { describe, expect } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";

const BUNDLE = "knowledge/accounts";

describe("a registry serving a knowledge bundle beside its skills", () => {
  test("installs the skills and leaves the bundle out with a warning, recording nothing for it", () => {
    const sources = acquired(
      [
        entry(),
        entry({
          name: "accounts",
          kind: "knowledge",
          path: BUNDLE,
          from: { file: `${BUNDLE}/index.md`, pointer: "" },
        }),
      ],
      "c1",
      new Map([
        ["skills/lint", "sha256:t1"],
        [BUNDLE, "sha256:t2"],
      ]),
    );
    const plan = build(
      kitManifest(["kit/skill/lint", "kit/knowledge/accounts"]),
      emptyLock(),
      sources,
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(plan.warnings).toEqual([
      {
        name: "accounts",
        message:
          "kit/knowledge/accounts is a knowledge bundle, which aireg publishes but installs into no target, so it is left out.",
      },
    ]);
    const record = plan.actions.find((action) => action.kind === "record");
    expect(record?.kind === "record" ? Object.keys(record.lock.artifacts) : []).toEqual(["lint"]);
  });
});
