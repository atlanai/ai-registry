import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { collidingPaths, expandHome, isSafePath, onPath, withAbsolutePath } from "./paths.ts";

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

/** Runs `run` as on Windows, where environment names ignore case. */
function asWindows<T>(run: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

const absolute = join(tmpdir(), "aireg-bin");

describe("withAbsolutePath", () => {
  test("keeps only the absolute folders on PATH", () => {
    const path = ["", ".", "bin", absolute].join(delimiter);
    expect(withAbsolutePath({ PATH: path, HOME: "/home/u" })).toEqual({
      PATH: absolute,
      HOME: "/home/u",
    });
  });

  test("leaves an environment without PATH alone", () => {
    expect(withAbsolutePath({ HOME: "/home/u" })).toEqual({ HOME: "/home/u" });
  });

  // Emptied instead, PATH would send the search to the child's working folder.
  test.each(["", ".", ["", ".", "bin"].join(delimiter)])("refuses PATH %j", (path) => {
    expect(() => withAbsolutePath({ PATH: path })).toThrow(
      "No folder on PATH is absolute, so aireg runs no program from it.",
    );
  });

  test("reads PATH under any case on Windows", () => {
    const path = [".", absolute].join(delimiter);
    expect(asWindows(() => withAbsolutePath({ Path: path }))).toEqual({ Path: absolute });
    expect(() => asWindows(() => withAbsolutePath({ Path: "." }))).toThrow(
      "No folder on PATH is absolute, so aireg runs no program from it.",
    );
  });
});

describe("onPath", () => {
  test("finds a program only in an absolute folder, not one relative to aireg's own", async () => {
    // Beside the working folder, so the relative spelling stays relative: on Windows the
    // temporary folder can sit on another drive, where `relative` gives an absolute path.
    const dir = await mkdtemp(join(process.cwd(), "node_modules", ".aireg-onpath-"));
    try {
      await writeFile(join(dir, "aireg-test-tool"), "");
      expect(onPath("aireg-test-tool", { PATH: dir })).toBe(true);
      expect(onPath("aireg-test-tool", { PATH: relative(process.cwd(), dir) })).toBe(false);
      expect(asWindows(() => onPath("aireg-test-tool", { Path: dir }))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
