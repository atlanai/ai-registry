import { describe, expect, it } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import {
  acquired,
  entry,
  kitManifest,
  linksTo,
  PLAN_OPTIONS,
  pluginCatalog,
} from "#test/kit/builders/plan.ts";

describe("two plugins publishing the same name", () => {
  it("keeps the first and says so, rather than linking one over the other", () => {
    const entries = [
      ...pluginCatalog("alpha"),
      entry({ name: "beta", kind: "plugin", path: "plugins/beta", group: undefined }),
      entry({ name: "fmt", kind: "skill", path: "plugins/beta/skills/fmt", group: "beta" }),
    ];
    const plan = build(
      kitManifest(["kit/alpha", "kit/beta"]),
      emptyLock(),
      acquired(entries, "c1", new Map()),
      { artifacts: {} },
      { ...PLAN_OPTIONS, targets: ["cursor"] },
    );

    // `fmt` is published by both, so only one link to it may exist. Cursor reads the shared folder.
    const fmt = linksTo(plan.actions, "agents").filter((to) => /[\\/]skills[\\/]fmt$/.test(to));
    expect(fmt).toHaveLength(1);
    expect(plan.clashes).toHaveLength(1);
    expect(plan.clashes[0]?.at).toBe(".agents/skills/fmt");
  });
});
