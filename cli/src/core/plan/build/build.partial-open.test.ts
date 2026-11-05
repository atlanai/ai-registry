import { describe, expect, test } from "vitest";
import type { Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import type { Action } from "#core/plan/model.ts";
import {
  acquired,
  entry,
  installed,
  kinds,
  kitManifest,
  PLAN_OPTIONS,
  SYNCED,
} from "#test/kit/builders/plan.ts";
import { build } from "./build.ts";

describe("a run that opened only some registries", () => {
  // Another registry's row, installed earlier and not opened by this run.
  function withFar(lock: Lock): Lock {
    lock.registries.far = {
      location: "https://github.com/acme/far.git",
      adapter: "git",
      key: "sha256:far",
      config: {},
      revision: "f1",
    };
    lock.artifacts.fmt = {
      registry: "far",
      id: "skills/fmt",
      name: "fmt",
      kind: "skill",
      namespace: undefined,
      address: "skills/fmt",
      path: "artifacts/far-copy",
      origin: undefined,
      content: "sha256:f1",
      version: undefined,
      digest: "sha256:3",
      links: [{ target: "claude-code", path: ".claude/skills/fmt", mode: "symlink" }],
    };
    return lock;
  }
  function withFarManifest(refs: string[]): Manifest {
    const declared = kitManifest(refs);
    declared.registries.far = {
      location: "https://github.com/acme/far.git",
      adapter: undefined,
      config: {},
    };
    return declared;
  }
  const recorded = (plan: { actions: Action[] }) => {
    const last = plan.actions.at(-1);
    if (last?.kind !== "record") throw new Error("no record action");
    return last.lock;
  };

  test("carries an unopened registry's rows and source through untouched", () => {
    const lock = withFar(installed());
    const plan = build(
      withFarManifest(["kit/skill/lint", "far/skill/fmt"]),
      lock,
      acquired([entry()]),
      SYNCED,
      { ...PLAN_OPTIONS, opened: ["kit"] },
    );
    expect(kinds(plan)).toEqual(["record"]);
    expect(recorded(plan).artifacts.fmt).toEqual(lock.artifacts.fmt);
    expect(recorded(plan).registries.far).toEqual(lock.registries.far);
  });

  test("keeps the installed row when an opened registry publishes the same name", () => {
    const lock = withFar(installed());
    const plan = build(
      withFarManifest(["kit/skill/lint", "kit/skill/fmt", "far/skill/fmt"]),
      lock,
      acquired([entry(), entry({ name: "fmt", path: "skills/fmt" })]),
      SYNCED,
      { ...PLAN_OPTIONS, opened: ["kit"] },
    );
    expect(recorded(plan).artifacts.fmt).toEqual(lock.artifacts.fmt);
    expect(plan.actions.some((action) => "name" in action && action.name === "fmt")).toBe(false);
    expect(plan.clashes).toContainEqual({
      name: "fmt",
      kept: "far/skill/fmt",
      dropped: "kit/skill/fmt",
    });
  });

  test("still removes the last artifact of a registry it opened", () => {
    const plan = build(withFarManifest(["far/skill/fmt"]), withFar(installed()), [], SYNCED, {
      ...PLAN_OPTIONS,
      opened: ["kit"],
    });
    expect(kinds(plan)).toEqual(["unlink", "unlink", "record"]);
    expect(Object.keys(recorded(plan).artifacts)).toEqual(["fmt"]);
    expect(Object.keys(recorded(plan).registries)).toEqual(["far"]);
  });
});
