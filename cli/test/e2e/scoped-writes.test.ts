import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { fileTest } from "#test/kit/fixtures.ts";

const test = fileTest.extend("market", { scope: "file" }, async ({ tmp }) => ({
  near: await registry(join(tmp, "near"), { name: "near", slug: "near" })
    .skill("team/lint@1.0.0", { body: "lint\n" })
    .skill("team/review@1.0.0", { body: "review\n" })
    .write(),
  far: await registry(join(tmp, "far"), { name: "far", slug: "far" })
    .skill("ops/deploy@1.0.0", { body: "deploy\n" })
    .write(),
}));

describe("an add or remove opens only the registry it changes", () => {
  // Run outside any project, so every add and remove goes to the user scope.
  const outside = (tmp: string) => ({ cwd: tmp });
  // A namespaced skill reaches Claude as itself: its namespace is where it came from.
  const skillFile = (home: string, name: string) =>
    join(home, ".claude", "skills", name, "SKILL.md");

  test("installs from two registries", async ({ aireg, tmp, market }) => {
    const at = outside(tmp);
    expect((await aireg(["registry", "add", market.near, "--as", "near"], at)).code).toBe(0);
    expect((await aireg(["registry", "add", market.far, "--as", "far"], at)).code).toBe(0);
    const first = await aireg(["add", "-g", "near/team/skill/lint", "-y"], at);
    expect(first.code, first.stderr).toBe(0);
    const second = await aireg(["add", "-g", "far/ops/skill/deploy", "-y"], at);
    expect(second.code, second.stderr).toBe(0);
  });

  test("adds from one while the other cannot be read, and leaves the other's install alone", async ({
    aireg,
    home,
    tmp,
    market,
  }) => {
    await rename(market.far, `${market.far}.gone`);
    const added = await aireg(["add", "-g", "near/team/skill/review", "-y"], outside(tmp));
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(skillFile(home.dir, "review"))).toBe(true);
    expect(existsSync(skillFile(home.dir, "deploy"))).toBe(true);
    const listed = await aireg(["list", "-g"], outside(tmp));
    expect(listed.stdout).toMatch(/deploy\s+skill\s+1\.0\.0\s+far/);
    expect(listed.stdout).toMatch(/review\s+skill\s+1\.0\.0\s+near/);
  });

  test("removes from one while the other cannot be read", async ({ aireg, home, tmp }) => {
    const removed = await aireg(["remove", "-g", "near/team/skill/lint", "-y"], outside(tmp));
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(skillFile(home.dir, "lint"))).toBe(false);
    expect(existsSync(skillFile(home.dir, "review"))).toBe(true);
    expect(existsSync(skillFile(home.dir, "deploy"))).toBe(true);
  });
});
