import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";

describe("remove names what it removed", () => {
  test("removing an artifact whose link was never made says Removed, not Updated", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "kit")).skill("skills/s").write();
    // A folder of the user's already sits where the link would go.
    await mkdir(join(project, ".claude", "skills", "s"), { recursive: true });
    await writeFile(join(project, ".claude", "skills", "s", "SKILL.md"), "mine\n");
    expect((await aireg(["init", "--for", "claude-code"])).code).toBe(0);
    const added = await aireg(["add", root, "--all", "-y"]);
    expect(added.stderr).toContain("already holds something of yours");

    const removed = await aireg(["remove", "s", "-y"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout + removed.stderr).not.toContain("Updated s.");
    expect(removed.stdout + removed.stderr).toContain("Removed s.");
  });
});
