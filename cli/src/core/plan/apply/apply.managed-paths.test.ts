import { symlinkSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { buildEnvelope, contentDigest } from "#adapter/index.ts";
import { sha256 } from "#adapter/spec/canonical.ts";
import { exists } from "#core/fs/tree.ts";
import { emptyLock } from "#core/lock.ts";
import { roots as makeRoots, type Roots, stagingDir } from "#core/store/paths.ts";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { apply } from "./apply.ts";
import { recover } from "./journal.ts";

let home: string;
let roots: Roots;
let source: string;
let outside: string;

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  vi.stubEnv("AIREG_HOME", join(home, "aireg"));
  roots = makeRoots("project", join(home, "project"));
  source = join(home, "source");
  outside = join(home, "outside");
  await mkdir(roots.cwd);
  await mkdir(source);
  await mkdir(outside);
  await writeFile(join(source, "SKILL.md"), "synthetic skill");
  await writeFile(join(outside, "sentinel"), "keep");
});
afterEach(async () => {
  vi.unstubAllEnvs();
});

test.each([".registry", ".registry/artifacts", ".registry/artifacts/acme/skills"])(
  "refuses a redirected %s before copying or journaling",
  async (parent) => {
    const redirected = join(roots.cwd, parent);
    await mkdir(dirname(redirected), { recursive: true });
    await symlink(outside, redirected);
    const plan = emptyPlan();
    plan.actions.push({ kind: "clone", name: "demo", from: source, to: join(redirected, "demo") });

    await expect(
      apply(plan, roots, async () => {
        throw new Error("unexpected fetch");
      }),
    ).rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
    expect(await exists(roots.applyJournal)).toBe(false);
  },
);

test("refuses a redirected projection before assembling it", async () => {
  const projection = join(roots.artifacts, ".projections", "acme");
  await mkdir(dirname(projection), { recursive: true });
  await symlink(outside, projection);
  const plan = emptyPlan();
  plan.actions.push({
    kind: "link",
    name: "demo",
    target: "claude-code",
    from: join(projection, "demo"),
    to: join(roots.cwd, ".claude", "skills", "demo"),
    copy: false,
    plugin: true,
    content: source,
  });

  await expect(
    apply(plan, roots, async () => {
      throw new Error("unexpected fetch");
    }),
  ).rejects.toThrow(/symlink/i);
  expect(await readdir(outside)).toEqual(["sentinel"]);
});

test("does not recover through a redirected artifact parent, and says so once", async () => {
  const parent = join(roots.artifacts, "acme");
  await mkdir(dirname(parent), { recursive: true });
  await symlink(outside, parent);
  await mkdir(dirname(roots.applyJournal), { recursive: true });
  await writeFile(roots.applyJournal, JSON.stringify({ writes: [join(parent, "sentinel")] }));

  const recovered = await recover(roots, emptyLock());
  expect(recovered.removed).toEqual([]);
  expect(recovered.skipped).toEqual([
    { path: join(parent, "sentinel"), reason: expect.stringMatching(/symlink/i) },
  ]);
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
  // Cleared, so the next run is not stopped by the same entry again.
  expect(await exists(roots.applyJournal)).toBe(false);
  expect(await recover(roots, emptyLock())).toEqual({ removed: [], skipped: [] });
});

test("rechecks a managed parent immediately before copying", async () => {
  await mkdir(roots.artifacts, { recursive: true });
  const parent = join(roots.artifacts, "acme");
  const plan = emptyPlan();
  plan.actions.push({ kind: "clone", name: "demo", from: source, to: join(parent, "demo") });
  await expect(
    apply(
      plan,
      roots,
      async () => {
        throw new Error("unexpected fetch");
      },
      () => symlinkSync(outside, parent),
    ),
  ).rejects.toThrow(/symlink/i);
  expect(await readdir(outside)).toEqual(["sentinel"]);
});

test("rejects a dangling relative link instead of creating its destination", async () => {
  await mkdir(roots.artifacts, { recursive: true });
  const parent = join(roots.artifacts, "acme");
  await symlink("../../../missing", parent);
  const plan = emptyPlan();
  plan.actions.push({ kind: "clone", name: "demo", from: source, to: join(parent, "demo") });
  await expect(
    apply(plan, roots, async () => {
      throw new Error("unexpected fetch");
    }),
  ).rejects.toThrow(/symlink/i);
  expect(await exists(join(home, "missing"))).toBe(false);
});

test("refuses redirected staging before starting a fetch", async () => {
  const parent = join(stagingDir(), "acme");
  await mkdir(dirname(parent), { recursive: true });
  await symlink(outside, parent);
  const plan = emptyPlan();
  plan.actions.push({
    kind: "stage",
    name: "demo",
    source: "acme",
    path: "skill/demo",
    to: join(parent, "demo"),
  });
  const fetch = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  await expect(apply(plan, roots, fetch)).rejects.toThrow(/symlink/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(await exists(roots.applyJournal)).toBe(false);
});

test("keeps a shared target root and an explicitly selected user scope working", async () => {
  const scope = join(home, "user-scope");
  await mkdir(scope);
  const alias = join(home, "scope-alias");
  await symlink(scope, alias);
  roots = makeRoots("user", roots.cwd, { AIREG_USER_SCOPE: alias });
  const copy = join(roots.artifacts, "demo");
  const target = join(home, "shared-target");
  await symlink(outside, target);
  const plan = emptyPlan();
  plan.actions.push(
    { kind: "stage", name: "demo", source: "acme", path: "skill/demo", to: source },
    { kind: "clone", name: "demo", from: source, to: copy },
    {
      kind: "link",
      name: "demo",
      target: "claude-code",
      from: copy,
      to: join(target, "demo"),
      copy: false,
    },
  );
  const bytes = "synthetic skill";
  const envelope = buildEnvelope({
    kind: "skill",
    metadata: { name: "demo" },
    files: [{ path: "SKILL.md", digest: sha256(bytes), size: bytes.length }],
  });
  const result = await apply(plan, roots, async () => ({
    path: source,
    root: source,
    contentId: contentDigest(envelope),
    envelope,
    dropped: [],
  }));
  expect(result.installed).toEqual(["demo"]);
  expect(await readFile(join(outside, "demo", "SKILL.md"), "utf8")).toBe("synthetic skill");
});

test("does not mistake a descendant linking back to the cache root for a root alias", async () => {
  const actual = join(home, "actual-aireg");
  const alias = join(home, "aireg-alias");
  await mkdir(join(actual, "cache", ".staging"), { recursive: true });
  await symlink(actual, alias);
  vi.stubEnv("AIREG_HOME", alias);
  const parent = join(alias, "cache", ".staging", "acme");
  await symlink(actual, parent);
  await writeFile(join(actual, "demo"), "keep");
  const plan = emptyPlan();
  plan.actions.push({
    kind: "stage",
    name: "demo",
    source: "acme",
    path: "skill/demo",
    to: join(parent, "demo"),
  });
  const fetch = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  await expect(apply(plan, roots, fetch)).rejects.toThrow(/symlink/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(join(actual, "demo"), "utf8")).toBe("keep");
});
