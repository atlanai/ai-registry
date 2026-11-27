import { existsSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { tree } from "#test/kit/tree.ts";

// Both are documented settings, and a user lock is never committed, so its paths may leave HOME.
test("reads its own lock back when the user scope and a target home are outside HOME", async ({
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

  const added = await aireg(["add", "-g", market, "--all", "--yes", "--for", "claude-code"], at);
  expect(added.code, added.stderr).toBe(0);
  expect(existsSync(skill), `${added.stdout}\n${tree(claude)}`).toBe(true);

  const listed = await aireg(["list", "-g"], at);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout).toMatch(/lint\s+skill\s+1\.0\.0/);

  const removed = await aireg(["remove", "-g", "acme/eng/skill/lint", "-y"], at);
  expect(removed.code, removed.stderr).toBe(0);
  expect(existsSync(skill)).toBe(false);
});

test("prints hints that act on the user scope, with -g", async ({ aireg, home, tmp }) => {
  const root = await skillsFolder(join(tmp, "kit")).skill("skills/a").skill("skills/b").write();
  const cwd = home.dir; // not a project, as for most `-g` runs
  for (const name of ["a", "b"]) {
    const added = await aireg(["add", "-g", root, "-s", name, "--for", "claude-code", "-y"], {
      cwd,
    });
    expect(added.code, added.stderr).toBe(0);
  }

  // b: an installed copy edited in place.
  await appendFile(
    join(home.scope, "artifacts", "kit", "kit", "skills", "b", "SKILL.md"),
    "edit\n",
  );
  const installed = await aireg(["install", "-g"], { cwd });
  expect(installed.stderr).toContain("was edited after installation");
  const removed = await aireg(["remove", "-g", "b", "-y"], { cwd });
  expect(removed.code).toBe(3);

  // a: the registry stops listing it.
  await rm(join(root, "skills", "a"), { recursive: true });
  const updated = await aireg(["update", "-g"], { cwd });
  expect(updated.stderr).toContain('no longer lists "a"');
  const synced = await aireg(["sync", "-g", "--dry-run"], { cwd });
  expect(synced.stderr).toContain("aireg publish");

  const runs = [installed, removed, updated, synced];
  const hinted = runs.flatMap((run) =>
    [...run.stderr.matchAll(/`(aireg [^`]+)`/g)].map((m) => m[1]),
  );
  expect(hinted.length).toBeGreaterThan(0);
  for (const command of hinted) expect(command, command).toMatch(/(^| )-g( |$)/);
});
