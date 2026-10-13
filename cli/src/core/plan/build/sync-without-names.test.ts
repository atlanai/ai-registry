import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { emptyLock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import { type BuildOptions, build } from "#core/plan/build.ts";
import type { Acquired, Action } from "#core/plan/model.ts";
import { roots } from "#core/store/paths.ts";
import {
  acquired,
  entry,
  kitManifest,
  linksTo,
  PLAN_OPTIONS,
  wrapping,
} from "#test/kit/builders/plan.ts";

describe("a sync that reads one registry and names none", () => {
  // The daemon's path: it reads the job's registry and passes no `opened`.
  const USER = roots("user", "/work");
  const home = homedir();
  const options: BuildOptions = { ...PLAN_OPTIONS, roots: USER, targets: ["claude"] };
  const claudeSkills = (name: string) => join(home, ".claude", "skills", name);
  function engineeringSource(alias: string, skill: string): Acquired {
    const [base] = wrapping(
      acquired([entry({ name: skill, path: `engineering/skills/${skill}`, group: "engineering" })]),
    );
    if (base === undefined) throw new Error("no source");
    return { ...base, alias };
  }
  function farRow(): Lock {
    const lock = emptyLock();
    lock.registries.far = {
      location: "https://github.com/acme/far.git",
      adapter: "git",
      key: "sha256:far",
      config: {},
      revision: "c1",
    };
    lock.artifacts.fmt = {
      registry: "far",
      id: "engineering/skills/fmt",
      name: "fmt",
      kind: "skill",
      namespace: "engineering",
      address: "engineering/skills/fmt",
      path: ".registry/artifacts/far/engineering/skills/fmt",
      origin: undefined,
      content: "sha256:t1",
      version: undefined,
      digest: "sha256:3",
      links: [{ harness: "claude", path: ".claude/skills/engineering", mode: "symlink" }],
    };
    return lock;
  }
  function declaringFar(refs: string[]): Manifest {
    const declared = kitManifest(refs);
    declared.registries.far = {
      location: "https://github.com/acme/far.git",
      adapter: undefined,
      config: {},
    };
    return declared;
  }
  const unlinks = (plan: { actions: Action[] }) =>
    plan.actions.filter((action) => action.kind === "unlink").map((action) => action.to);

  it("counts a declared registry's rows, and leaves the directory they still record", () => {
    const plan = build(
      declaringFar(["kit", "far"]),
      farRow(),
      [engineeringSource("kit", "lint")],
      { artifacts: {} },
      options,
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("kit-engineering")]);
    expect(unlinks(plan)).not.toContain(claudeSkills("engineering"));
  });

  it("counts your own rows in a declared registry nothing asks for", () => {
    const lock = farRow();
    const fmt = lock.artifacts.fmt as LockArtifact;
    lock.artifacts.fmt = {
      ...fmt,
      origin: { harness: "claude", path: ".claude/skills", step: "" },
    };
    const plan = build(
      declaringFar(["kit"]),
      lock,
      [engineeringSource("kit", "lint")],
      { artifacts: {} },
      options,
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("kit-engineering")]);
  });

  it("ignores the rows of a registry no longer declared", () => {
    const plan = build(
      kitManifest(["kit"]),
      farRow(),
      [engineeringSource("kit", "lint")],
      { artifacts: {} },
      options,
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("engineering")]);
  });

  it("still removes what a run naming that registry dropped, though it read nothing", () => {
    const plan = build(
      declaringFar([]),
      farRow(),
      [],
      { artifacts: {} },
      {
        ...options,
        opened: ["far"],
      },
    );
    expect(unlinks(plan)).toContain(claudeSkills("engineering"));
  });
});
