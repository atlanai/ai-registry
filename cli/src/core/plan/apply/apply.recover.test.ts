import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect } from "vitest";
import { exists } from "#core/fs/tree.ts";
import { emptyLock, type Lock } from "#core/lock.ts";
import { roots as makeRoots, type Roots, stagingDir } from "#core/store/paths.ts";
import { lock as lockOf } from "#test/kit/builders/lock.ts";
import { test } from "#test/kit/fixtures.ts";
import { recover } from "./journal.ts";

let home: string;
let roots: Roots;
let env: NodeJS.ProcessEnv;

function locked(): Lock {
  return lockOf()
    .registry("mkt", {
      location: "https://example.test/mkt.git",
      key: "sha256:test",
      revision: "a".repeat(40),
    })
    .artifact("lint", {
      id: "skills/lint",
      address: "skills/lint",
      path: "artifacts/copy",
      content: "sha256:upstream",
      digest: "sha256:1",
      links: [{ target: "claude-code", path: ".claude/skills/lint", mode: "symlink" }],
    })
    .build();
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  env = { ...process.env, AIREG_HOME: join(home, ".registry-home") };
  roots = makeRoots("project", home, env);
});

async function journal(writes: string[], at: Roots = roots): Promise<void> {
  await mkdir(dirname(at.applyJournal), { recursive: true });
  await writeFile(at.applyJournal, JSON.stringify({ writes }));
}

describe("recover", () => {
  // The journal records staged writes as well as links, so claiming only links
  // would make recovery delete the artifact's one writable copy, edits included.
  test("keeps the copy the lock still owns", async () => {
    const lock = locked();
    const staged = resolve(roots.base, "artifacts/copy");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "SKILL.md"), "work in progress\n");

    const link = resolve(roots.base, ".claude/skills/lint");
    await journal([staged, link]);

    const { removed } = await recover(roots, lock, env);

    expect(removed).toEqual([]);
    expect(await exists(join(staged, "SKILL.md"))).toBe(true);
    expect(await exists(roots.applyJournal)).toBe(false);
  });

  test("still removes a path the lock has forgotten", async () => {
    const staged = join(stagingDir(env), "mkt", "mkt", "skill", "lint", "0");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "SKILL.md"), "orphan\n");
    await journal([staged]);

    const { removed } = await recover(roots, locked(), env);

    expect(removed).toEqual([staged]);
    expect(await exists(staged)).toBe(false);
  });

  test("keeps the journal with aireg, never in the project", () => {
    expect(relative(env.AIREG_HOME ?? "", roots.applyJournal).startsWith("..")).toBe(false);
    expect(relative(join(home, ".registry"), roots.applyJournal).startsWith("..")).toBe(true);
  });

  // Recovery checks every entry as it would one from the lock, wherever the journal came from.
  test("never removes a journal path outside what aireg places", async ({ tmp }) => {
    const outside = tmp;
    const project = join(home, "src");
    await mkdir(project, { recursive: true });
    await mkdir(join(outside, "keys"));
    // A committed symlink passes a check on the path alone.
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(outside, join(home, ".claude", "skills"));
    await mkdir(join(home, ".cursor"), { recursive: true });
    await symlink("/", join(home, ".cursor", "skills"));
    const writes = [
      outside,
      project,
      home,
      "../..",
      join(home, ".claude", "skills", "keys"),
      join(home, ".cursor", "skills", relative("/", join(outside, "keys"))),
    ];
    await journal(writes);

    expect((await recover(roots, emptyLock(), env)).removed).toEqual([]);
    for (const dir of [outside, project, join(outside, "keys")]) {
      expect(await exists(dir)).toBe(true);
    }
    expect(await exists(roots.applyJournal)).toBe(false);
  });
});
