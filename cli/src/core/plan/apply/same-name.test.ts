import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import type { LinkMode } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { lock as lockOf } from "#test/kit/builders/lock.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";

let root: string;
let roots: Roots;
let store: string;

test.beforeEach(async ({ tmp }) => {
  root = join(tmp, "home");
  vi.stubEnv("AIREG_HOME", join(tmp, "aireg"));
  roots = makeRoots("project", root);
  store = join(roots.artifacts, "mkt", "ws", "skills", "hello");
  await skill(store, "hello");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const skills = () => join(root, ".agents", "skills");
const dest = () => join(skills(), "hello");
const fetch = () => Promise.reject(new Error("nothing to fetch"));

async function skill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

function nestedPlan(options: { nested?: boolean; recorded?: LinkMode } = {}): Plan {
  const lock = lockOf()
    .artifact("ws/hello", {
      registry: "mkt",
      id: "skill_1",
      namespace: "ws",
      address: "ws/skills/hello",
      path: ".registry/artifacts/mkt/ws/skills/hello",
      content: "sha256:c",
      version: "1",
      digest: "sha256:d",
      links: [{ target: "universal", path: ".agents/skills/hello", mode: "symlink" }],
    })
    .build();
  return {
    ...emptyPlan(),
    actions: [
      {
        kind: "link",
        name: "ws/hello",
        target: "universal",
        from: store,
        to: dest(),
        copy: false,
        ...(options.nested === false ? {} : { nested: true }),
        ...(options.recorded === undefined ? {} : { recorded: options.recorded }),
      },
      { kind: "record", lock },
    ],
  };
}

async function linked(): Promise<boolean> {
  return (await lstat(dest()).catch(() => undefined))?.isSymbolicLink() === true;
}

describe("a target that finds skills at any depth", () => {
  test("leaves out a skill whose name one in a category folder already has", async () => {
    await skill(join(skills(), "software-development", "hello"), "hello");
    const plan = nestedPlan();
    const result = await apply({ plan, roots, fetch, env: process.env });
    expect(await linked()).toBe(false);
    const record = plan.actions.find((action) => action.kind === "record");
    const row = record?.kind === "record" ? record.lock.artifacts["ws/hello"] : undefined;
    expect(row?.links).toEqual([]);
    expect(row?.blocked).toEqual([
      { target: "universal", path: ".agents/skills/software-development/hello" },
    ]);
    expect(result.kept).toEqual([
      {
        name: "ws/hello",
        path: dest(),
        reason: `a skill of the same name is at ${join("software-development", "hello")}, and the target would load neither`,
      },
    ]);
  });

  test("reads a skill's name from its front matter before its folder", async () => {
    await skill(join(skills(), "notes", "renamed"), "hello");
    await skill(join(skills(), "notes", "hello-like"), "other");
    const result = await apply({ plan: nestedPlan(), roots, fetch, env: process.env });
    expect(result.kept[0]?.reason).toContain(join("notes", "renamed"));
  });

  test("links beside skills of other names and folders it skips", async () => {
    await skill(join(skills(), "devops", "deploy"), "deploy");
    await skill(join(skills(), ".hub", "hello"), "hello");
    await skill(join(skills(), "devops", "deploy", "hello"), "hello");
    const result = await apply({ plan: nestedPlan(), roots, fetch, env: process.env });
    expect(result.kept).toEqual([]);
    expect(await linked()).toBe(true);
  });

  test("keeps updating a link the lock already records", async () => {
    await skill(join(skills(), "software-development", "hello"), "hello");
    const plan = nestedPlan({ recorded: "symlink" });
    const result = await apply({ plan, roots, fetch, env: process.env });
    expect(result.kept).toEqual([]);
    expect(await linked()).toBe(true);
  });

  test("checks nothing for a target that finds skills only at the top", async () => {
    await skill(join(skills(), "software-development", "hello"), "hello");
    const plan = nestedPlan({ nested: false });
    const result = await apply({ plan, roots, fetch, env: process.env });
    expect(result.kept).toEqual([]);
    expect(await linked()).toBe(true);
  });
});
