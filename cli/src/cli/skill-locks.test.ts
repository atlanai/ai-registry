import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { readSkillLock } from "./skill-locks.ts";

async function lockFile(dir: string, document: unknown): Promise<string> {
  const path = join(dir, "skills-lock.json");
  await writeFile(path, typeof document === "string" ? document : JSON.stringify(document));
  return path;
}

describe("readSkillLock", () => {
  test("reads a project's file, taking only where each skill came from", async ({ tmp }) => {
    const path = await lockFile(tmp, {
      version: 1,
      skills: {
        "pr-review": {
          source: "example/skills",
          sourceType: "github",
          skillPath: "skills/pr-review/SKILL.md",
          computedHash: "0".repeat(64),
          extra: { ignored: true },
        },
        notes: {
          source: "https://example.test/skills",
          sourceType: "well-known",
          skillPath: "notes/SKILL.md",
        },
      },
    });
    expect(await readSkillLock(path)).toEqual({
      skills: [
        {
          name: "pr-review",
          address: "github.com/example/skills",
          ref: undefined,
          folder: "skills/pr-review",
        },
        { name: "notes", address: "https://example.test/skills", ref: undefined, folder: "notes" },
      ],
      skipped: [],
      user: false,
    });
  });

  test("reads a user's file by its full source URL", async ({ tmp }) => {
    const path = await lockFile(tmp, {
      version: 3,
      skills: {
        lint: {
          source: "example/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/example/skills.git",
          ref: "v2",
          skillPath: "skills/lint/SKILL.md",
          skillFolderHash: "abc",
        },
      },
    });
    const lock = await readSkillLock(path);
    expect(lock.user).toBe(true);
    expect(lock.skills).toEqual([
      {
        name: "lint",
        address: "https://github.com/example/skills.git",
        ref: "v2",
        folder: "skills/lint",
      },
    ]);
  });

  test("skips a source type it does not read, and a path that leaves its source", async ({
    tmp,
  }) => {
    const path = await lockFile(tmp, {
      version: 1,
      skills: {
        odd: { source: "x/y", sourceType: "pigeon", skillPath: "odd/SKILL.md" },
        out: { source: "x/y", sourceType: "github", skillPath: "../out/SKILL.md" },
      },
    });
    expect((await readSkillLock(path)).skipped).toEqual([
      `Skipped "odd" in ${path}: its source type, "pigeon", is not one aireg reads.`,
      `Skipped "out" in ${path}: its skillPath is not a path inside its source.`,
    ]);
  });

  test("refuses a file that is not a skills lock", async ({ tmp }) => {
    await expect(readSkillLock(await lockFile(tmp, "{ nope"))).rejects.toThrow(
      "is not valid JSON.",
    );
    await expect(readSkillLock(await lockFile(tmp, { skills: [] }))).rejects.toThrow(
      "it needs a `version` and a `skills` map.",
    );
  });
});
