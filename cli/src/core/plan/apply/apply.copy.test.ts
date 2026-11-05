import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { emptyLock } from "#core/lock.ts";
import type { Action } from "#core/plan/model.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";

let roots: Roots;

// The test home sets CLAUDE_CONFIG_DIR, and removal is confined to the target folders it names.
test.beforeEach(async ({ home }) => {
  roots = makeRoots("user", home.dir);
});

describe("a plugin placed as a copy", () => {
  test("holds every member, though it was copied when the first one landed", async ({ home }) => {
    const content = join(roots.artifacts, "acme", "kit");
    const projection = join(roots.artifacts, ".projections", "acme", "kit");
    await mkdir(join(content, "skills", "ship"), { recursive: true });
    await mkdir(projection, { recursive: true });
    await symlink(relative(projection, join(content, "skills")), join(projection, "skills"));
    const to = join(home.dir, ".claude", "skills", "kit");
    const link: Action = {
      kind: "link",
      name: "kit/ship",
      target: "claude-code",
      from: projection,
      to,
      copy: true,
      plugin: true,
      content,
    };
    const plan = {
      ...emptyPlan(),
      actions: [link, { kind: "record" as const, lock: emptyLock() }],
    };

    // A member cloned after the plugin's first link, as a later clone in the plan would be.
    await apply(
      plan,
      roots,
      () => Promise.reject(new Error("nothing is staged")),
      (action) => {
        if (action.kind === "record") mkdirSync(join(content, "skills", "lint"));
      },
    );
    expect((await readdir(join(to, "skills"))).sort()).toEqual(["lint", "ship"]);
  });
});

describe("a copy installed under another name", () => {
  test("carries that name in a skill folder and in a single file", async ({ home }) => {
    const skill = join(roots.artifacts, "acme", "pr-review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: pr-review\n---\nBody.\n");
    const agent = join(roots.artifacts, "acme", "reviewer.md");
    await writeFile(agent, "---\nname: reviewer\n---\nBody.\n");
    const skillTo = join(home.dir, ".claude", "skills", "eng-pr-review");
    const agentTo = join(home.dir, ".claude", "agents", "eng-reviewer.md");
    const copied = (name: string, from: string, to: string, rename: string): Action => ({
      kind: "link",
      name,
      target: "claude-code",
      from,
      to,
      copy: true,
      rename,
    });
    const plan = {
      ...emptyPlan(),
      actions: [
        copied("pr-review", skill, skillTo, "eng-pr-review"),
        copied("reviewer", agent, agentTo, "eng-reviewer"),
        { kind: "record" as const, lock: emptyLock() },
      ],
    };

    await apply(plan, roots, () => Promise.reject(new Error("nothing is staged")));

    expect(await readFile(join(skillTo, "SKILL.md"), "utf8")).toContain("name: eng-pr-review");
    expect(await readFile(agentTo, "utf8")).toContain("name: eng-reviewer");
  });
});
