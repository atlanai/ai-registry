import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import type { LinkMode } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { lock } from "#test/kit/builders/lock.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";

const AGENT =
  "---\nname: reviewer\ndescription: Reviews.\ntools: Read\nmodel: sonnet\n---\nReview it.\n";
const TOML =
  'name = "reviewer"\ndescription = "Reviews."\ndeveloper_instructions = """\nReview it."""\n';
const CODEC = {
  id: "frontmatter-toml" as const,
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

function renderPlan(recorded?: LinkMode, entry?: { to: string; entry: string }): Plan {
  const recording = lock()
    .artifact("reviewer", {
      registry: "kit",
      id: "agents/reviewer.md",
      kind: "agent",
      address: "agents/reviewer.md",
      path: ".registry/artifacts/kit/kit/agents/reviewer.md",
      content: "sha256:c",
      digest: "sha256:d",
      links: [{ target: "codex", path: ".codex/agents/reviewer.toml", mode: "symlink" }],
    })
    .build();
  return {
    ...emptyPlan(),
    actions: [
      {
        kind: "link",
        name: "reviewer",
        target: "codex",
        from: copy,
        to: target,
        copy: true,
        ...(entry === undefined ? { codec: CODEC } : entry),
        ...(recorded === undefined ? {} : { recorded }),
      },
      { kind: "record", lock: recording },
    ],
  };
}

describe("a rendered placement", () => {
  test("adopts a file already holding what it would write, and keeps any other", async () => {
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, TOML);
    const adopted = await apply({
      plan: renderPlan(),
      roots,
      fetch: () => Promise.reject(new Error("no fetch")),
      env: process.env,
    });
    expect(adopted.kept).toEqual([]);
    expect(adopted.lock?.artifacts.reviewer?.links[0]?.mode).toBe("copy");

    await writeFile(target, 'name = "mine"\n');
    const kept = await apply({
      plan: renderPlan(),
      roots,
      fetch: () => Promise.reject(new Error("no fetch")),
      env: process.env,
    });
    expect(kept.kept).toEqual([{ name: "reviewer", path: target }]);
    expect(await readFile(target, "utf8")).toBe('name = "mine"\n');
  });

  test("is not written when the agent has nothing to put in it, and says why", async () => {
    await writeFile(copy, "---\nname: reviewer\n---\nReview it.\n");
    const applied = await apply({
      plan: renderPlan(),
      roots,
      fetch: () => Promise.reject(new Error("no fetch")),
      env: process.env,
    });
    expect(applied.unrendered).toEqual([
      { name: "reviewer", target: "codex", reason: "it has no description" },
    ]);
    expect(applied.lock?.artifacts.reviewer?.links).toEqual([]);
    expect(applied.lock?.artifacts.reviewer?.blocked).toBeUndefined();
    await expect(lstat(target)).rejects.toThrow();
  });

  test("takes on a folder holding only its entry, and keeps one holding anything else", async () => {
    const folder = join(roots.base, ".claude", "agents", "reviewer");
    const entry = { to: folder, entry: "AGENT.md" };
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "AGENT.md"), AGENT);
    await writeFile(join(folder, "notes.md"), "mine\n");
    const kept = await apply({
      plan: renderPlan(undefined, entry),
      roots,
      fetch: () => Promise.reject(new Error("no fetch")),
      env: process.env,
    });
    expect(kept.kept).toEqual([{ name: "reviewer", path: folder }]);
    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("mine\n");

    await rm(join(folder, "notes.md"));
    const adopted = await apply({
      plan: renderPlan(undefined, entry),
      roots,
      fetch: () => Promise.reject(new Error("no fetch")),
      env: process.env,
    });
    expect(adopted.kept).toEqual([]);
    expect(await readFile(join(folder, "AGENT.md"), "utf8")).toBe(AGENT);
  });
});
