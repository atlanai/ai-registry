import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { tree } from "#test/kit/tree.ts";

// Both are documented settings, and a user lock is never committed, so its paths may leave HOME.
test("reads its own lock back when the user scope and a harness home are outside HOME", async ({
  aireg,
  tmp,
}) => {
  const market = await registry(join(tmp, "market"), { name: "acme", slug: "acme" })
    .skill("eng/lint@1.0.0")
    .write();
  const claude = join(tmp, "claudehome");
  const env = { AIREG_USER_SCOPE: join(tmp, "elsewhere", "scope"), CLAUDE_CONFIG_DIR: claude };
  const at = { cwd: tmp, env };
  const skill = join(claude, "skills", "lint", "SKILL.md");

  const added = await aireg(["add", "-g", market, "--all", "--yes", "--for", "claude"], at);
  expect(added.code, added.stderr).toBe(0);
  expect(existsSync(skill), `${added.stdout}\n${tree(claude)}`).toBe(true);

  const listed = await aireg(["list", "-g"], at);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout).toMatch(/lint\s+skill\s+1\.0\.0/);

  const removed = await aireg(["remove", "-g", "acme/eng/skill/lint", "-y"], at);
  expect(removed.code, removed.stderr).toBe(0);
  expect(existsSync(skill)).toBe(false);
});
