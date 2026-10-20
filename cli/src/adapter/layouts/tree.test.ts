import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { openTree, TREE_LIMITS } from "./tree.ts";

describe("openTree", () => {
  test("walks regular files, skipping links, tooling folders and hidden ones", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "src"))
      .file("a/SKILL.md", "a")
      .file("a/run.sh", "#!/bin/sh\n", true)
      .file("a/node_modules/x/index.js", "x")
      .file("a/.cache/kept-out", "x")
      .file("a/.claude/kept", "x")
      .file("a/.DS_Store", "x")
      .file("a/.env.example", "x")
      .link("a/outside", "/etc")
      .write();
    const tree = await openTree(root);
    const walked = await tree.walk("a");
    expect(walked.files.map((file) => [file.path, file.executable])).toEqual([
      ["a/.claude/kept", false],
      ["a/.env.example", false],
      ["a/SKILL.md", false],
      // Windows keeps no execute bit.
      ["a/run.sh", process.platform !== "win32"],
    ]);
    expect(walked.skipped).toEqual([{ path: "a/outside", reason: "is a symlink" }]);
    expect(await tree.isFile("a/SKILL.md")).toBe(true);
    expect(await tree.isFile("a/outside")).toBe(false);
    await expect(tree.read("a/outside")).rejects.toThrow("a/outside is a symlink.");
  });

  test("refuses to read through a link", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "src"))
      .file("real/SKILL.md", "a")
      .link("alias", "real")
      .write();
    const tree = await openTree(root);
    await expect(tree.read("alias/SKILL.md")).rejects.toThrow(/symlink/);
    await expect(tree.list("alias")).rejects.toThrow(/symlink/);
  });

  test("stops at its file, byte and depth limits", async ({ tmp }) => {
    const root = join(tmp, "src");
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    for (const name of ["one", "two", "three"]) await writeFile(join(root, "a", name), "12345");
    await writeFile(join(root, "a", "b", "c", "deep"), "x");
    const files = await openTree(root, { ...TREE_LIMITS, files: 2 });
    await expect(files.walk("a")).rejects.toThrow("This source holds more than 2 files.");
    const bytes = await openTree(root, { ...TREE_LIMITS, bytes: 8 });
    await expect(bytes.walk("a")).rejects.toThrow("This source holds more than 8 bytes.");
    const depth = await openTree(root, { ...TREE_LIMITS, depth: 1 });
    await expect(depth.walk("a")).rejects.toThrow("a/b/c is nested more than 1 folders deep.");
  });

  test("refuses a root that is a link", async ({ tmp }) => {
    const root = await skillsFolder(join(tmp, "src"))
      .file("real/SKILL.md", "a")
      .link("alias", "real")
      .write();
    await expect(openTree(join(root, "alias"))).rejects.toThrow(/symlink/);
  });
});
