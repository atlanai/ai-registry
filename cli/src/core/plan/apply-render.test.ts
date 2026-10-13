import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { emptyLock, type LinkMode, type Lock } from "#core/lock.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";
import type { Plan } from "./model.ts";

const AGENT =
  "---\nname: reviewer\ndescription: Reviews.\ntools: Read\nmodel: sonnet\n---\nReview it.\n";
const TOML =
  'name = "reviewer"\ndescription = "Reviews."\ndeveloper_instructions = """\nReview it."""\n';
const RENDER = {
  format: "toml" as const,
  fields: ["name", "description"],
  body: "developer_instructions",
};

let roots: Roots;
let copy: string;
let target: string;

test.beforeEach(async ({ tmp }) => {
  vi.stubEnv("AIREG_HOME", join(tmp, "aireg"));
  roots = makeRoots("project", join(tmp, "project"));
  copy = join(roots.artifacts, "kit", "kit", "agents", "reviewer.md");
  target = join(roots.base, ".codex", "agents", "reviewer.toml");
  await mkdir(join(copy, ".."), { recursive: true });
  await writeFile(copy, AGENT);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function renderPlan(recorded?: LinkMode): Plan {
  const lock: Lock = emptyLock();
  lock.artifacts.reviewer = {
    registry: "kit",
    id: "agents/reviewer.md",
    name: "reviewer",
    kind: "agent",
    namespace: undefined,
    address: "agents/reviewer.md",
    path: ".registry/artifacts/kit/kit/agents/reviewer.md",
    origin: undefined,
    content: "sha256:c",
    version: undefined,
    digest: "sha256:d",
    links: [{ harness: "codex", path: ".codex/agents/reviewer.toml", mode: "symlink" }],
  };
  return {
    ...emptyPlan(),
    actions: [
      {
        kind: "link",
        name: "reviewer",
        harness: "codex",
        from: copy,
        to: target,
        copy: true,
        render: RENDER,
        ...(recorded === undefined ? {} : { recorded }),
      },
      { kind: "record", lock },
    ],
  };
}

describe("a rendered placement", () => {
  test("adopts a file already holding what it would write, and keeps any other", async () => {
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, TOML);
    const adopted = await apply(renderPlan(), roots, () => Promise.reject(new Error("no fetch")));
    expect(adopted.kept).toEqual([]);
    expect(adopted.lock?.artifacts.reviewer?.links[0]?.mode).toBe("copy");

    await writeFile(target, 'name = "mine"\n');
    const kept = await apply(renderPlan(), roots, () => Promise.reject(new Error("no fetch")));
    expect(kept.kept).toEqual([{ name: "reviewer", path: target }]);
    expect(await readFile(target, "utf8")).toBe('name = "mine"\n');
  });

  test("is not written when the agent has nothing to put in it, and says why", async () => {
    await writeFile(copy, "---\nname: reviewer\n---\nReview it.\n");
    const applied = await apply(renderPlan(), roots, () => Promise.reject(new Error("no fetch")));
    expect(applied.unrendered).toEqual([
      { name: "reviewer", harness: "codex", reason: "it has no description" },
    ]);
    expect(applied.lock?.artifacts.reviewer?.links).toEqual([]);
    expect(applied.lock?.artifacts.reviewer?.blocked).toBeUndefined();
    await expect(lstat(target)).rejects.toThrow();
  });
});
