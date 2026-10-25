import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import { test as withTmp } from "#test/kit/fixtures.ts";
import {
  collidingPaths,
  expandHome,
  isSafePath,
  onPath,
  programPath,
  withAbsolutePath,
} from "./paths.ts";

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
  test("leaves an environment without PATH alone", () => {
    expect(withAbsolutePath({ HOME: "/home/u" })).toEqual({ HOME: "/home/u" });
  });

  test("reads PATH under any case on Windows", () => {
    const path = [".", absolute].join(delimiter);
    expect(asWindows(() => withAbsolutePath({ Path: path }))).toEqual({ Path: absolute });
  });
});

describe("onPath", () => {
  // An existing folder beside the working folder: a temporary one can sit on another
  // Windows drive, where no relative spelling reaches it.
  test("finds a program only in an absolute folder, not one relative to aireg's own", () => {
    const bin = join("node_modules", ".bin");
    expect(onPath("vitest", { PATH: join(process.cwd(), bin) })).toBe(true);
    expect(onPath("vitest", { PATH: bin })).toBe(false);
  });
});

describe("programPath", () => {
  async function folderWith(dir: string, file: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), "");
    return dir;
  }

  withTmp("finds a Windows program on PATH, never in the working folder", async ({ tmp }) => {
    const work = await folderWith(join(tmp, "work"), "tool.exe");
    const bin = await folderWith(join(tmp, "bin"), "tool.exe");
    const env = { Path: [work, bin].join(delimiter) };
    expect(asWindows(() => programPath("tool", env, work))).toBe(join(bin, "tool.exe"));
    expect(asWindows(() => programPath("tool", { Path: work }, work))).toBeUndefined();
  });

  withTmp("runs Windows' own helpers from System32, whatever PATH holds", async ({ tmp }) => {
    const bin = await folderWith(tmp, "reg.exe");
    const env = { SystemRoot: "D:\\Windows", PATH: bin };
    expect(asWindows(() => programPath("reg", env))).toBe(
      join("D:\\Windows", "System32", "reg.exe"),
    );
    expect(asWindows(() => programPath("reg", { ...env, SystemRoot: "Windows" }))).toBe(
      join("C:\\Windows", "System32", "reg.exe"),
    );
  });
});
