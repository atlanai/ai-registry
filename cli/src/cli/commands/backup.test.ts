import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { moveToBackup } from "#core/store/backups.ts";
import { roots as makeRoots } from "#core/store/paths.ts";
import { commandContext } from "#test/kit/command.ts";
import { test } from "#test/kit/fixtures.ts";
import { run } from "./backup.ts";

const STAMP = "20261019T000000Z";

async function skill(at: string, text: string): Promise<void> {
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "SKILL.md"), text);
}

async function jsonOf(argv: string[], cwd: string): Promise<{ ok: boolean; data: unknown }> {
  const printed: string[] = [];
  await run(commandContext(argv, { cwd, printed }));
  return JSON.parse(printed.join(""));
}

describe("aireg backup", () => {
  test("lists a run and restores it, leaving a taken path alone", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const skills = join(home.dir, ".claude", "skills");
    await skill(join(skills, "lint"), "lint\n");
    await skill(join(skills, "review"), "old review\n");
    for (const name of ["lint", "review"]) {
      await moveToBackup(join(skills, name), roots, STAMP, `claude-code/skills/${name}`);
    }
    await skill(join(skills, "review"), "new review\n");
    const backups = join(roots.artifacts, "..", "backups");

    expect(await jsonOf(["list", "-g"], home.dir)).toEqual({
      ok: true,
      data: {
        scope: "user",
        root: backups,
        runs: [
          {
            stamp: STAMP,
            at: "2026-10-19T00:00:00.000Z",
            counts: { "claude-code": 2 },
            items: ["lint", "review"].map((name) => ({
              name,
              target: "claude-code",
              dir: "skills",
              path: join(backups, STAMP, "claude-code", "skills", name),
              origin: join(skills, name),
            })),
          },
        ],
      },
    });

    expect(await jsonOf(["restore", STAMP, "-g"], home.dir)).toEqual({
      ok: true,
      data: {
        scope: "user",
        stamp: STAMP,
        restored: [{ name: "lint", target: "claude-code", path: join(skills, "lint") }],
        skipped: [
          {
            name: "review",
            target: "claude-code",
            path: join(skills, "review"),
            reason: "taken",
          },
        ],
      },
    });
    expect(await readFile(join(skills, "lint", "SKILL.md"), "utf8")).toBe("lint\n");
    expect(await readFile(join(skills, "review", "SKILL.md"), "utf8")).toBe("new review\n");
    const left = join(backups, STAMP, "claude-code", "skills", "review", "SKILL.md");
    expect(await readFile(left, "utf8")).toBe("old review\n");
  });

  test("asks for a run's stamp when it cannot offer a list", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    await skill(join(home.dir, ".claude", "skills", "lint"), "lint\n");
    await moveToBackup(
      join(home.dir, ".claude", "skills", "lint"),
      roots,
      STAMP,
      "claude-code/skills/lint",
    );
    await expect(run(commandContext(["restore", "-g"], { cwd: home.dir }))).rejects.toThrow(
      /`aireg backup restore` needs a run/,
    );
    await expect(
      run(commandContext(["restore", "20200101T000000Z", "-g"], { cwd: home.dir })),
    ).rejects.toThrow(/No backup run 20200101T000000Z/);
  });

  test("says so when nothing was moved aside", async ({ home }) => {
    expect(await jsonOf(["list", "-g"], home.dir)).toMatchObject({ data: { runs: [] } });
    await expect(run(commandContext(["restore", "-g"], { cwd: home.dir }))).rejects.toThrow(
      /Nothing is in your user scope's backups/,
    );
  });
});
