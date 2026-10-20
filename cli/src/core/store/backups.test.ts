import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { moveToBackup } from "./backups.ts";
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
