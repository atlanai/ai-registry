import { mkdir, symlink, writeFile } from "node:fs/promises";
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

  test("follows a link to a skill kept elsewhere, and names each harness linking it", async ({
    status,
    home,
  }) => {
    const kept = join(home.dir, "kept", "course");
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, "SKILL.md"), "---\nname: course\ndescription: A course.\n---\n");
    for (const harness of [".claude", ".cursor"]) {
      await mkdir(join(home.dir, harness, "skills"), { recursive: true });
      await symlink(kept, join(home.dir, harness, "skills", "course"));
    }
    const { data } = JSON.parse(await status(["--json"]));
    const course = data.unmanaged.find((item: { name: string }) => item.name === "course");
    expect(course).toMatchObject({ kind: "skill", harnesses: ["claude", "cursor"] });
  });

  test("names a harness once, and the real folder rather than a link to it", async ({
    status,
    home,
  }) => {
    const real = join(home.dir, ".cursor", "skills", "course");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "SKILL.md"), "---\nname: course\ndescription: A course.\n---\n");
    for (const name of ["course", "course-alias"]) {
      await symlink(real, join(home.dir, ".claude", "skills", name));
    }
    const { data } = JSON.parse(await status(["--json"]));
    const course = data.unmanaged.find((item: { name: string }) => item.name === "course");
    expect(course).toMatchObject({ harnesses: ["claude", "cursor"], path: real });
  });

  test("reads Codex's own agent files, and names a link whose target is gone", async ({
    status,
    home,
  }) => {
    const agents = join(home.dir, ".codex", "agents");
    await mkdir(agents, { recursive: true });
    const toml = (name: string) =>
      `name = "${name}"\ndescription = "Written by hand."\ndeveloper_instructions = "Hi."\n`;
    await writeFile(join(agents, "triage.toml"), toml("triage"));
    await writeFile(join(agents, "solo.toml"), toml("solo"));
    const gone = join(home.dir, ".claude", "agents", "gone.md");
    await symlink(join(home.dir, "nowhere.md"), gone);

    const { data } = JSON.parse(await status(["--json"]));
    const harnessesOf = (name: string) =>
      data.unmanaged.find((item: { name: string }) => item.name === name)?.harnesses;
    expect(harnessesOf("triage")).toEqual(["claude", "codex"]);
    expect(harnessesOf("solo")).toEqual(["codex"]);
    expect(data.dangling).toEqual([
      { path: gone, target: join(home.dir, "nowhere.md"), harness: "claude" },
    ]);

    const text = await status([]);
    expect(text).toContain("1 dangling link");
    expect(text).toMatch(/~\/\.claude\/agents\/gone\.md\s+Claude Code\s+\S*nowhere\.md/);
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
