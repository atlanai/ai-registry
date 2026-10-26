import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Acquired, Staged } from "#core/plan/model.ts";
import type { RemovableRoots } from "#core/plan/removable.ts";
import type { Candidate } from "#core/sync/adopt.ts";
import { test } from "#test/kit/fixtures.ts";
import { moveAside, surveyClaims } from "./claim.ts";

let root: string;
let roots: RemovableRoots;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  roots = { scope: "project", cwd: root, artifacts: join(root, ".registry", "artifacts") };
});

async function skill(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
  return dir;
}

function candidate(name: string, from: string, elsewhere: Candidate["elsewhere"] = []): Candidate {
  return {
    name,
    kind: "skill",
    from,
    target: "claude-code",
    suggestedPath: `skills/${name}`,
    description: undefined,
    elsewhere,
  };
}

/** One registry publishing `name` with the bytes at `served`. */
function registry(alias: string, name: string, served: string): Acquired {
  return {
    alias,
    catalog: {
      root: "",
      layouts: [],
      warnings: [],
      entries: [
        {
          name,
          kind: "skill",
          path: `ws/skills/${name}`,
          group: "ws",
          description: undefined,
          engine: undefined,
          from: { file: "", pointer: "" },
        },
      ],
    },
    placements: new Map(),
    content: async () => ({ path: served, root: served }) as Staged,
    close: async () => {},
  } as unknown as Acquired;
}

describe("surveyClaims", () => {
  test("claims every copy that holds the registry's bytes and holds back one that differs", async () => {
    const served = await skill(join(root, "served"), "same\n");
    const claude = await skill(join(root, ".claude/skills/hello"), "same\n");
    const agents = await skill(join(root, ".agents/skills/hello"), "same\n");
    const codex = await skill(join(root, ".codex/skills/hello"), "edited\n");
    const claims = await surveyClaims(
      [
        candidate("hello", claude, [
          { from: agents, target: "universal" },
          { from: codex, target: "codex" },
        ]),
      ],
      [registry("acme", "hello", served)],
      "acme",
    );
    expect(claims).toEqual([
      {
        name: "hello",
        kind: "skill",
        entries: ["ws/skills/hello"],
        identical: [
          { from: claude, target: "claude-code" },
          { from: agents, target: "universal" },
        ],
        different: [{ from: codex, target: "codex" }],
      },
    ]);
  });

  test("ignores what another registry publishes", async () => {
    const served = await skill(join(root, "served"), "same\n");
    const claude = await skill(join(root, ".claude/skills/hello"), "same\n");
    const claims = await surveyClaims(
      [candidate("hello", claude)],
      [registry("other", "hello", served)],
      "acme",
    );
    expect(claims).toEqual([]);
  });
});

describe("moveAside", () => {
  test("moves each copy under the backups, by target and kind, and a link as a link", async () => {
    const claude = await skill(join(root, ".claude/skills/hello"), "same\n");
    const target = await skill(join(root, "dev/hello"), "same\n");
    const linked = join(root, ".agents/skills/hello");
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    await symlink(target, linked);
    const moved = await moveAside(
      "skill",
      "hello",
      [
        { from: claude, target: "claude-code" },
        { from: linked, target: "universal" },
      ],
      roots,
      "20260924T120000Z",
    );
    const at = join(root, ".registry", "backups", "20260924T120000Z");
    expect(moved).toEqual([
      { from: claude, to: join(at, "claude-code/skills/hello") },
      { from: linked, to: join(at, "universal/skills/hello") },
    ]);
    await expect(lstat(claude)).rejects.toThrow();
    expect((await lstat(join(at, "claude-code/skills/hello/SKILL.md"))).isFile()).toBe(true);
    expect(await readlink(join(at, "universal/skills/hello"))).toBe(target);
    expect((await lstat(join(target, "SKILL.md"))).isFile()).toBe(true);
  });

  test("leaves a copy reached through a target folder that is a link", async () => {
    const outside = await skill(join(root, "outside/hello"), "same\n");
    await mkdir(join(root, ".claude"), { recursive: true });
    await symlink(join(root, "outside"), join(root, ".claude/skills"));
    const moved = await moveAside(
      "skill",
      "hello",
      [{ from: join(root, ".claude/skills/hello"), target: "claude-code" }],
      roots,
      "20260924T120000Z",
    );
    expect(moved).toEqual([]);
    expect((await lstat(join(outside, "SKILL.md"))).isFile()).toBe(true);
  });
});
