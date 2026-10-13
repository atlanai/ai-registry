import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { emptyLock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import { type BuildOptions, build } from "#core/plan/build.ts";
import type { Acquired, Action } from "#core/plan/model.ts";
import { projectionDir, roots } from "#core/store/paths.ts";
import {
  acquired,
  entry,
  kitManifest,
  linksTo,
  PLAN_OPTIONS,
  wrapping,
} from "#test/kit/builders/plan.ts";

// Both sources declare each namespace a plugin, which is what makes two of them share a directory.
describe("two registries with a namespace of the same name", () => {
  const USER = roots("user", "/work");
  const home = homedir();
  const options: BuildOptions = { ...PLAN_OPTIONS, roots: USER, targets: ["claude", "codex"] };
  const claudeSkills = (name: string) => join(home, ".claude", "skills", name);

  function source(alias: "kit" | "far", skill: string): Acquired {
    const [base] = wrapping(
      acquired([entry({ name: skill, path: `engineering/skills/${skill}`, group: "engineering" })]),
    );
    if (base === undefined) throw new Error("no source");
    const location = `https://github.com/acme/${alias}.git`;
    return {
      ...base,
      alias,
      origin: { ...base.origin, location, declared: location, key: `sha256:${alias}` },
    };
  }
  function both(): Manifest {
    const declared = kitManifest(["kit", "far"]);
    declared.registries.far = {
      location: "https://github.com/acme/far.git",
      adapter: undefined,
      config: {},
    };
    return declared;
  }
  function linkOf(plan: { actions: Action[] }, harness: string, to: string) {
    return plan.actions.find(
      (action): action is Extract<Action, { kind: "link" }> =>
        action.kind === "link" && action.harness === harness && action.to === to,
    );
  }
  function installedRow(alias: "kit" | "far", skill: string, link: string): LockArtifact {
    return {
      registry: alias,
      id: `engineering/skills/${skill}`,
      name: skill,
      kind: "skill",
      namespace: "engineering",
      address: `engineering/skills/${skill}`,
      path: `.registry/artifacts/${alias}/engineering/skills/${skill}`,
      origin: undefined,
      content: "sha256:t1",
      version: undefined,
      digest: "sha256:3",
      links: [{ harness: "claude", path: link, mode: "symlink" }],
    };
  }
  function lockSource(alias: "kit" | "far") {
    return {
      location: `https://github.com/acme/${alias}.git`,
      adapter: "git",
      key: `sha256:${alias}`,
      config: {},
      revision: "c1",
    };
  }
  // What an earlier run of `far` alone recorded, before `kit` published `engineering`.
  function farInstalled(): Lock {
    const lock = emptyLock();
    lock.registries.far = lockSource("far");
    lock.artifacts.fmt = installedRow("far", "fmt", ".claude/skills/engineering");
    return lock;
  }

  it("gives each its own Claude plugin, named after its registry", () => {
    const plan = build(
      both(),
      emptyLock(),
      [source("kit", "lint"), source("far", "fmt")],
      { artifacts: {} },
      options,
    );
    // Claude keys plugins by manifest name and loads only the first of two alike.
    expect(linksTo(plan.actions, "claude")).toEqual([
      claudeSkills("far-engineering"),
      claudeSkills("kit-engineering"),
    ]);
    expect(linkOf(plan, "claude", claudeSkills("kit-engineering"))?.from).toBe(
      projectionDir(USER, "kit", "kit-engineering"),
    );
    expect(plan.warnings.map((warning) => warning.message)).toContain(
      'The namespace "engineering" is also published by another registry, so claude loads the one from kit as "kit-engineering".',
    );
  });

  it("gives Codex each namespace as a plugin of its own registry, so neither is renamed", () => {
    const plan = build(
      both(),
      emptyLock(),
      [source("kit", "lint"), source("far", "fmt")],
      { artifacts: {} },
      options,
    );
    const cache = (alias: string) =>
      join(home, ".codex", "plugins", "cache", alias, "engineering", "local");
    expect(linksTo(plan.actions, "codex")).toEqual([cache("far"), cache("kit")]);
    expect(linkOf(plan, "codex", cache("kit"))?.from).toBe(
      projectionDir(USER, "kit", "engineering"),
    );
    expect(linksTo(plan.actions, "agents")).toEqual([]);
  });

  it("keeps the bare name while only one registry publishes the namespace", () => {
    const plan = build(
      kitManifest(["kit"]),
      emptyLock(),
      [source("kit", "lint")],
      { artifacts: {} },
      options,
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("engineering")]);
    expect(plan.warnings.some((warning) => /another registry/.test(warning.message))).toBe(false);
  });

  it("counts the namespace a registry this run did not open still holds", () => {
    const lock = farInstalled();
    const plan = build(
      both(),
      lock,
      [source("kit", "lint")],
      { artifacts: {} },
      {
        ...options,
        opened: ["kit"],
      },
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("kit-engineering")]);
    // `far` keeps its directory until its own run renames it.
    expect(
      plan.actions.some(
        (action) => action.kind === "unlink" && action.to === claudeSkills("engineering"),
      ),
    ).toBe(false);
  });

  it("moves an installed namespace to its qualified name once another registry shares it", () => {
    // `kit` already ran and took its qualified name; `far` has not caught up.
    const lock = farInstalled();
    lock.registries.kit = lockSource("kit");
    lock.artifacts.lint = installedRow("kit", "lint", ".claude/skills/kit-engineering");
    const plan = build(
      both(),
      lock,
      [source("far", "fmt")],
      { artifacts: {} },
      {
        ...options,
        opened: ["far"],
      },
    );
    expect(linksTo(plan.actions, "claude")).toEqual([claudeSkills("far-engineering")]);
    expect(
      plan.actions.some(
        (action) => action.kind === "unlink" && action.to === claudeSkills("engineering"),
      ),
    ).toBe(true);
  });
});
