import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { backupStamp, listBackups, moveToBackup, stampTime } from "./backups.ts";
import { roots as makeRoots } from "./paths.ts";

describe("moveToBackup", () => {
  test("files a profile's placement under a name every platform can hold", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const from = join(home.dir, ".tool", "skills", "lint");
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "SKILL.md"), "mine\n");
    const to = await moveToBackup(from, roots, "20261019T000000Z", "tool:work/skills/lint");
    const backups = join(roots.artifacts, "..", "backups");
    expect(to).toBe(join(backups, "20261019T000000Z", "tool-work", "skills", "lint"));
  });
});

describe("listBackups", () => {
  async function file(path: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "mine\n");
  }

  test("lists runs newest first, with what each moved", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const backups = join(roots.artifacts, "..", "backups");
    await file(join(backups, "20261019T000000Z", "claude-code", "skills", "lint", "SKILL.md"));
    await file(join(backups, "20261019T000000Z-2", "codex", "agents", "review.toml"));
    await file(join(backups, "20261019T000000Z-10", "codex", "agents", "triage.toml"));
    await file(join(backups, "20261101T120000Z", "claude-code", "skills", ".DS_Store"));
    const runs = await listBackups(roots);
    expect(runs.map((run) => run.stamp)).toEqual([
      "20261019T000000Z-10",
      "20261019T000000Z-2",
      "20261019T000000Z",
    ]);
    expect(runs[2]?.items).toEqual([
      {
        target: "claude-code",
        dir: "skills",
        name: "lint",
        path: join(backups, "20261019T000000Z", "claude-code", "skills", "lint"),
      },
    ]);
    expect(runs[2]?.atMs).toBe(Date.UTC(2026, 9, 19));
  });

  test("finds nothing when no run has moved anything", async ({ home }) => {
    expect(await listBackups(makeRoots("user", home.dir))).toEqual([]);
  });

  test("refuses a backups folder that is a link", async ({ home, tmp }) => {
    const roots = makeRoots("user", home.dir);
    const elsewhere = join(tmp, "elsewhere");
    await file(join(elsewhere, "20261019T000000Z", "claude-code", "skills", "lint", "SKILL.md"));
    await mkdir(join(roots.artifacts, ".."), { recursive: true });
    await symlink(elsewhere, join(roots.artifacts, "..", "backups"));
    await expect(listBackups(roots)).rejects.toThrow(/symlink/);
  });
});

describe("stampTime", () => {
  test("reads a stamp and its same-second suffix, and nothing else", () => {
    expect(stampTime(backupStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))))).toBe(
      Date.UTC(2026, 0, 2, 3, 4, 5),
    );
    expect(stampTime("20260102T030405Z-3")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(stampTime("notes")).toBeUndefined();
  });
});
