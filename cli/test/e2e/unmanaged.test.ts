import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";

/** A home whose Claude folder holds a skill and an agent nothing installed. */
const test = base.extend("status", async ({ aireg, home }) => {
  const claude = join(home.dir, ".claude");
  await mkdir(join(claude, "skills", "notes"), { recursive: true });
  await writeFile(
    join(claude, "skills", "notes", "SKILL.md"),
    "---\nname: notes\ndescription: Keep notes.\n---\n",
  );
  await mkdir(join(claude, "agents"), { recursive: true });
  await writeFile(join(claude, "agents", "triage.md"), "---\nname: triage\n---\n");
  return async (args: string[]) => {
    const ran = await aireg(["status", "-g", ...args], { cwd: home.dir });
    expect(ran.code, ran.stderr).toBe(0);
    return ran.stdout;
  };
});

describe("aireg status, for what nothing manages", () => {
  test("names each unmanaged artifact, of every kind, and where it is", async ({ status }) => {
    const out = await status([]);
    expect(out).toContain("2 unmanaged");
    expect(out).toMatch(/notes\s+skill\s+Claude Code\s+~\/\.claude\/skills\/notes/);
    expect(out).toMatch(/triage\s+agent\s+Claude Code\s+~\/\.claude\/agents\/triage\.md/);
  });

  test("answers the same in JSON", async ({ status }) => {
    const { data } = JSON.parse(await status(["--json"]));
    expect(
      data.unmanaged.map((item: { name: string; kind: string }) => [item.kind, item.name]).sort(),
    ).toEqual([
      ["agent", "triage"],
      ["skill", "notes"],
    ]);
  });
});
