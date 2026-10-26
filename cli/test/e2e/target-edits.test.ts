import { readdirSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, type Git, fileTest as test } from "#test/kit/fixtures.ts";

let aireg: Aireg;
let git: Git;
let root: string;
let market: string;

test.beforeAll(async ({ aireg: run, git: gitIn, tmp }) => {
  [aireg, git, root, market] = [run, gitIn, tmp, join(tmp, "market")];
  const built = registry(market, { name: "acme", slug: "acme" });
  for (const version of ["1.0.0", "1.1.0"]) {
    built.skill(`platform/lint@${version}`, { body: `lint ${version}\n` });
  }
  await built.write();
});

describe("a copy the target owns", () => {
  const copied = () => join(root, "copied");
  const run = (args: string[]) => aireg(args, { cwd: copied() });
  const targetCopy = async (): Promise<string> => {
    const root = join(copied(), ".claude");
    const found = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => basename(path) === "SKILL.md" && path.includes("lint"))
      .map((path) => join(root, path))[0];
    if (found === undefined || found === "") throw new Error("no copied SKILL.md");
    return found;
  };

  beforeAll(async () => {
    await mkdir(copied(), { recursive: true });
    await git.init(copied());
    expect((await run(["init", "-y", "--for", "claude-code"])).code).toBe(0);
    expect((await run(["registry", "add", market, "--as", "acme"])).code).toBe(0);
    const added = await run(["add", "acme/platform/skill/lint@1.0.0", "--copy", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect((await lstat(await targetCopy())).isSymbolicLink()).toBe(false);
  });

  test("sees an edit to the copy, and keeps it through an update", async () => {
    await appendFile(await targetCopy(), "My own note.\n");
    const seen = await run(["status"]);
    expect(seen.code).toBe(3);
    expect(seen.stdout).toMatch(/copy was edited after installation/);
    const moved = await run(["add", "acme/platform/skill/lint", "-y"]);
    expect(moved.stderr).toMatch(
      /was edited after installation in \.claude\/skills\/lint, so it was left as it is/,
    );
    expect(await readFile(await targetCopy(), "utf8")).toContain("My own note.");
  });

  test("keeps an edited copy on remove, and deletes it with --force", async () => {
    const kept = await run(["remove", "lint", "-y"]);
    expect(kept.code).toBe(3);
    expect(kept.stderr).toMatch(/lint has local edits, so nothing was removed\./);
    expect(await readFile(await targetCopy(), "utf8")).toContain("My own note.");
    const forced = await run(["remove", "lint", "-y", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    await expect(targetCopy()).rejects.toThrow();
  });
});

describe("a folder of yours where a link would go", () => {
  const blocked = () => join(root, "blocked");
  const run = (args: string[]) => aireg(args, { cwd: blocked() });

  beforeAll(async () => {
    await mkdir(join(blocked(), ".claude", "skills", "lint"), { recursive: true });
    await writeFile(join(blocked(), ".claude", "skills", "lint", "SKILL.md"), "mine\n");
    await git.init(blocked());
    expect((await run(["init", "-y", "--for", "claude-code"])).code).toBe(0);
    expect((await run(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  });

  test("is named by a dry run as a path it will skip", async () => {
    const planned = await run(["add", "acme/platform/skill/lint", "-y", "--dry-run"]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stderr).toMatch(
      /Would not install lint, because \.claude\/skills\/lint already holds something of yours\./,
    );
  });

  test("is left alone, and status says the link is missing until it moves", async () => {
    const added = await run(["add", "acme/platform/skill/lint", "-y"]);
    expect(added.stderr).toMatch(/already holds something of yours/);
    // Counted by what it did, not what it planned.
    expect(added.stdout).not.toMatch(/installed/i);
    expect((await run(["install"])).stdout).toContain("Already up to date");
    const again = JSON.parse((await run(["install", "--json"])).stdout).data;
    expect(again).toMatchObject({ changed: 0, installed: [] });
    expect(again.kept).toEqual([
      { name: "lint", path: expect.stringMatching(/\.claude[\\/]skills[\\/]lint$/) },
    ]);
    const seen = await run(["status"]);
    expect(seen.code).toBe(3);
    expect(seen.stdout).toMatch(/missing +something of yours is at \.claude\/skills\/lint/);
    const json = JSON.parse((await run(["status", "--json"])).stdout);
    expect(json.data.artifacts[0].detail).toBe(
      "claude-code: something of yours is at .claude/skills/lint",
    );
    expect(await readFile(join(blocked(), ".claude", "skills", "lint", "SKILL.md"), "utf8")).toBe(
      "mine\n",
    );

    await rm(join(blocked(), ".claude", "skills", "lint"), { recursive: true });
    expect((await run(["install"])).code).toBe(0);
    expect((await run(["status"])).code).toBe(0);
  });
});
