import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collidingPaths, expandHome, isSafePath } from "./paths.ts";

describe("isSafePath", () => {
  test.each([
    "SKILL.md",
    "scripts/run.sh",
    "references/a.b/c.md",
    ".claude-plugin/plugin.json",
    ".gitignore",
    "git/notes.md",
    "a/.github/workflow.yml",
  ])("takes %j", (path) => {
    expect(isSafePath(path)).toBe(true);
  });

  test.each([
    "",
    ".",
    "/etc/passwd",
    "a//b",
    "./a",
    "a/./b",
    "a/",
    "../a",
    "a/../b",
    "a\\b",
    "C:/x",
    "C:x",
    "notes.md:stream",
    "a\u0000b",
    "a\nb",
    ".git/config",
    "a/.git/hooks/pre-commit",
    ".GIT/config",
    ".Git/HEAD",
    ".git./config",
    ".git /config",
    "git~1/config",
    "GIT~1/config",
    ".g\u200cit/config",
    "a/.git",
  ])("refuses %j", (path) => {
    expect(isSafePath(path)).toBe(false);
  });
});

describe("collidingPaths", () => {
  test("finds two files one case-insensitive disk would store as one", () => {
    expect(collidingPaths(["SKILL.md", "skill.md"])).toEqual(["skill.md", "SKILL.md"]);
  });

  test("finds a file named like a folder another file sits in", () => {
    expect(collidingPaths(["docs", "Docs/a.md"])).toEqual(["Docs/a.md", "docs"]);
  });

  test("takes paths that differ in more than case", () => {
    expect(collidingPaths(["SKILL.md", "docs/a.md", "docs/b.md"])).toBeUndefined();
  });
});

describe("expandHome", () => {
  test("expands ~, and leaves anything else alone", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/.claude", "/home/u")).toBe(join("/home/u", ".claude"));
    expect(expandHome("~other/x", "/home/u")).toBe("~other/x");
    expect(expandHome("/opt/tool", "/home/u")).toBe("/opt/tool");
  });

  test.runIf(process.platform === "win32")("expands ~\\ as Windows people type it", () => {
    expect(expandHome("~\\work\\skills", "C:\\Users\\u")).toBe("C:\\Users\\u\\work\\skills");
  });
});
