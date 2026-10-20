import { mkdirSync } from "node:fs";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";
import type { Action } from "./model.ts";

let roots: Roots;

// The test home sets CLAUDE_CONFIG_DIR, and removal is confined to the harness folders it names.
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
      harness: "claude",
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
