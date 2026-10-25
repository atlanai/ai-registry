import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { emptyLock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import { type BuildOptions, build } from "#core/plan/build.ts";
import type { Acquired, Action } from "#core/plan/model.ts";
import { projectionDir, roots } from "#core/store/paths.ts";
import { manifest } from "#test/kit/builders/manifest.ts";
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

// A qualified name is the registry's alias and the namespace joined, so two pairs can spell one.
describe("registries whose plugin names meet once qualified", () => {
  const USER = roots("user", "/work");
  const options: BuildOptions = {
    ...PLAN_OPTIONS,
    roots: USER,
    targets: ["claude"],
    nameCollision: "rename",
  };
  const claudeSkills = (name: string) => join(homedir(), ".claude", "skills", name);
  const location = (alias: string) => `https://github.com/acme/${alias}.git`;

  function source(alias: string, namespace: string, ...skills: string[]): Acquired {
    const entries = skills.map((skill) =>
      entry({ name: skill, path: `${namespace}/skills/${skill}`, group: namespace }),
    );
    const [base] = wrapping(acquired(entries));
    if (base === undefined) throw new Error("no source");
    const at = location(alias);
    return { ...base, alias, origin: { ...base.origin, location: at, declared: at, key: alias } };
  }
  function declaring(aliases: readonly string[]): Manifest {
    const declared = manifest();
    for (const alias of aliases) declared.registry(alias, location(alias));
    return declared.artifacts(...aliases).build();
  }
  function linkFrom(plan: { actions: Action[] }, to: string): string[] {
    return plan.actions.flatMap((action) =>
      action.kind === "link" && action.to === to ? [action.from] : [],
    );
  }
  function installedAt(
    lock: Lock,
    at: { alias: string; namespace: string; skill: string },
  ): LockArtifact {
    lock.registries[at.alias] = {
      location: location(at.alias),
      adapter: "git",
      key: at.alias,
      config: {},
      revision: "c1",
    };
    const row: LockArtifact = {
      registry: at.alias,
      id: `${at.namespace}/skills/${at.skill}`,
      name: at.skill,
      kind: "skill",
      namespace: at.namespace,
      address: `${at.namespace}/skills/${at.skill}`,
      path: `.registry/artifacts/${at.alias}/${at.namespace}/skills/${at.skill}`,
      origin: undefined,
      content: undefined,
      version: undefined,
      digest: "sha256:3",
      links: [],
    };
    lock.artifacts[`${at.namespace}/${at.skill}`] = row;
    return row;
  }

  // `a-b` and `x` share `c`, and `a` and `y` share `b-c`: both crowded pairs qualify to `a-b-c`.
  const SOURCES = [
    source("a-b", "c", "one"),
    source("x", "c", "two"),
    source("a", "b-c", "three"),
    source("y", "b-c", "four"),
  ];

  it("links one registry's plugin where two qualified names meet, and reports the other", () => {
    // `six` is a second skill in `three`'s namespace.
    const sources = [
      ...SOURCES.filter((each) => each.alias !== "a"),
      source("a", "b-c", "three", "six"),
    ];
    const plan = build(
      declaring(["a-b", "x", "a", "y"]),
      emptyLock(),
      sources,
      { artifacts: {} },
      options,
    );
    expect(linkFrom(plan, claudeSkills("a-b-c"))).toEqual([projectionDir(USER, "a", "a-b-c")]);
    expect(plan.clashes).toEqual([
      {
        name: "c/one",
        kept: "a/b-c/skill/three",
        dropped: "a-b/c/skill/one",
        at: ".claude/skills/a-b-c",
        container: true,
      },
    ]);
  });

  it("qualifies a bare name that another registry's qualified name lands on", () => {
    const plan = build(
      declaring(["q", "x", "z"]),
      emptyLock(),
      [source("q", "c", "one"), source("x", "c", "two"), source("z", "q-c", "three")],
      { artifacts: {} },
      options,
    );
    expect(linksTo(plan.actions, "claude")).toEqual([
      claudeSkills("q-c"),
      claudeSkills("x-c"),
      claudeSkills("z-q-c"),
    ]);
    expect(linkFrom(plan, claudeSkills("q-c"))).toEqual([projectionDir(USER, "q", "q-c")]);
    expect(plan.clashes).toEqual([]);
  });

  it("frees a folder an installed artifact moves out of in the same run", () => {
    // Installed flat before `t` wrapped namespaces: `other/team` holds `.claude/skills/team`.
    const lock = emptyLock();
    installedAt(lock, { alias: "t", namespace: "other", skill: "team" }).links = [
      { harness: "claude", path: ".claude/skills/team", mode: "symlink" },
    ];
    installedAt(lock, { alias: "t", namespace: "team", skill: "deploy" }).links = [
      { harness: "claude", path: ".claude/skills/deploy", mode: "symlink" },
    ];
    const [wrapped] = wrapping(
      acquired([
        entry({ name: "team", path: "other/skills/team", group: "other" }),
        entry({ name: "deploy", path: "team/skills/deploy", group: "team" }),
      ]),
    );
    if (wrapped === undefined) throw new Error("no source");
    const at = location("t");
    const t = {
      ...wrapped,
      alias: "t",
      origin: { ...wrapped.origin, location: at, declared: at, key: "t" },
    };
    const plan = build(declaring(["t"]), lock, [t], { artifacts: {} }, options);
    expect(linkFrom(plan, claudeSkills("team"))).toEqual([projectionDir(USER, "t", "team")]);
    expect(plan.clashes).toEqual([]);
  });

  it("leaves the plugin directory the lockfile gives another registry's namespace to it", () => {
    // `one` holds `a-b-c` already; `three`, planned first, moves there from `b-c` now `y` has one.
    const lock = emptyLock();
    installedAt(lock, { alias: "a-b", namespace: "c", skill: "one" }).links = [
      { harness: "claude", path: ".claude/skills/a-b-c", mode: "symlink" },
    ];
    installedAt(lock, { alias: "a", namespace: "b-c", skill: "three" }).links = [
      { harness: "claude", path: ".claude/skills/b-c", mode: "symlink" },
    ];
    const plan = build(
      declaring(["a-b", "x", "a", "y"]),
      lock,
      SOURCES,
      { artifacts: {} },
      options,
    );
    expect(linkFrom(plan, claudeSkills("a-b-c"))).toEqual([projectionDir(USER, "a-b", "a-b-c")]);
    expect(plan.clashes).toEqual([
      {
        name: "b-c/three",
        kept: "a-b/c/skill/one",
        dropped: "a/b-c/skill/three",
        at: ".claude/skills/a-b-c",
        container: true,
      },
    ]);
  });
});
