import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";

/** Commands a hint prints in backticks. */
const commandsIn = (text: string) => [...text.matchAll(/`(aireg [^`]+)`/g)].map((m) => m[1]);

describe("user-scope hints name -g", () => {
  test("install -g, update -g and remove -g print hints that run against the user scope", async ({
    aireg,
    home,
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "kit")).skill("skills/a").skill("skills/b").write();
    const cwd = home.dir; // not a project, as for most `-g` runs
    expect(
      (await aireg(["add", "-g", root, "-s", "a", "--for", "claude-code", "-y"], { cwd })).code,
    ).toBe(0);
    expect(
      (await aireg(["add", "-g", root, "-s", "b", "--for", "claude-code", "-y"], { cwd })).code,
    ).toBe(0);

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

    const hinted = [installed, removed, updated].flatMap((run) => commandsIn(run.stderr));
    expect(hinted.length).toBeGreaterThan(0);
    // Every command a user-scope run tells the user to run must itself target the user scope.
    for (const command of hinted) expect(command, command).toMatch(/(^| )-g( |$)/);
  });
});
