import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { fileTest as test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";

/** Outside any project, where a newer lint is written and published over the installed one. */
let work: string;

test.beforeAll(async ({ aireg, tmp, project, git }) => {
  work = join(tmp, "work");
  await mkdir(join(work, "lint"), { recursive: true });
  const team = await registry(join(tmp, "registry"), { name: "team", slug: "team" })
    .skill("platform/deploy@0.1.0")
    .skill("platform/lint@0.1.0")
    .write();
  const declared = await aireg(["registry", "add", team], { cwd: work });
  expect(declared.code, declared.stderr).toBe(0);
  await git.init(project);
});

describe("publishing an installed copy", () => {
  test("sends an edit to an installed copy home, and the lock follows it", async ({
    aireg,
    project,
  }) => {
    expect((await aireg(["add", "team/platform", "-y"], { cwd: project })).code).toBe(0);
    await appendFile(
      join(project, ".claude", "skills", "deploy", "SKILL.md"),
      "Watch the rollout.\n",
    );
    expect((await aireg(["status"], { cwd: project })).code).toBe(3);

    const named = await aireg(["publish"], { cwd: project });
    expect(named.code).toBe(2);
    expect(named.stderr).toContain("deploy");

    const sent = await aireg(["publish", "--yes"], { cwd: project });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/deploy\s+0\.1\.0 → 0\.1\.1/);
    expect((await aireg(["status"], { cwd: project })).code).toBe(0);
  });

  test("publishes an installed copy named by its target link", async ({ aireg, project }) => {
    await appendFile(join(project, ".claude", "skills", "deploy", "SKILL.md"), "Roll back.\n");

    const sent = await aireg(["publish", ".claude/skills/deploy", "--yes"], { cwd: project });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/deploy\s+0\.1\.1 → 0\.1\.2/);
  });

  test("refuses an edit made on a version something newer has replaced", async ({
    aireg,
    project,
  }) => {
    await writeFile(join(work, "lint", "SKILL.md"), skillBody("lint", "lint", "Newer upstream.\n"));
    expect(
      (await aireg(["publish", "lint", "--to", "team/platform", "--yes"], { cwd: work })).code,
    ).toBe(0);
    await appendFile(join(project, ".claude", "skills", "lint", "SKILL.md"), "Older edit.\n");

    const behind = await aireg(["publish", "lint", "--yes"], { cwd: project });
    expect(behind.code).toBe(3);
    expect(behind.stderr).toMatch(/would drop the changes in/);

    expect((await aireg(["publish", "lint", "--yes", "--force"], { cwd: project })).code).toBe(0);
  });
});
