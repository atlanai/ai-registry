import { describe, expect, it } from "vitest";
import { gitignore } from "./gitignore.ts";

const ignored = (patterns: string[], paths: string[]) => {
  const rules = gitignore(patterns);
  return paths.filter((path) => rules.ignores(path));
};

const PATHS = [
  "AGENT.md",
  "run.log",
  "notes/today.log",
  "workspace/AGENTS.md",
  "workspace/data/cache.json",
  "workspace-data/state.json",
  "deep/workspace-data/state.json",
  "docs/a/b/guide.md",
  "docs/guide.md",
];

describe("gitignore", () => {
  it("matches a pattern without a slash at any depth", () => {
    expect(ignored(["*.log"], PATHS)).toEqual(["run.log", "notes/today.log"]);
  });

  it("matches a folder pattern, and everything below it, only as a folder", () => {
    expect(ignored(["workspace-data/"], PATHS)).toEqual([
      "workspace-data/state.json",
      "deep/workspace-data/state.json",
    ]);
    // A file of that name is no folder.
    expect(ignored(["AGENT.md/"], PATHS)).toEqual([]);
  });

  it("anchors a pattern with a slash before its end to the folder", () => {
    expect(ignored(["/workspace-data"], PATHS)).toEqual(["workspace-data/state.json"]);
    expect(ignored(["workspace/data"], PATHS)).toEqual(["workspace/data/cache.json"]);
  });

  it("spans folders with **", () => {
    expect(ignored(["docs/**/guide.md"], PATHS)).toEqual(["docs/a/b/guide.md", "docs/guide.md"]);
    expect(ignored(["**/state.json"], PATHS)).toEqual([
      "workspace-data/state.json",
      "deep/workspace-data/state.json",
    ]);
    expect(ignored(["workspace/**"], PATHS)).toEqual([
      "workspace/AGENTS.md",
      "workspace/data/cache.json",
    ]);
  });

  it("keeps * and ? within one part, and reads a character class", () => {
    expect(ignored(["docs/*.md"], PATHS)).toEqual(["docs/guide.md"]);
    expect(ignored(["ru?.log"], PATHS)).toEqual(["run.log"]);
    expect(ignored(["[a-r]*.log"], PATHS)).toEqual(["run.log"]);
    expect(ignored(["[!r]*.log"], PATHS)).toEqual(["notes/today.log"]);
  });

  it("re-includes with !, but never below a folder it left out", () => {
    expect(ignored(["*.log", "!run.log"], PATHS)).toEqual(["notes/today.log"]);
    expect(ignored(["workspace/", "!workspace/AGENTS.md"], PATHS)).toEqual([
      "workspace/AGENTS.md",
      "workspace/data/cache.json",
    ]);
  });

  it("reads comments, blanks and escapes as git does", () => {
    expect(ignored(["# run.log", "", "\\#x"], ["run.log", "#x"])).toEqual(["#x"]);
    expect(ignored(["a.b"], ["a.b", "axb"])).toEqual(["a.b"]);
  });

  it("names the patterns that matched nothing it was asked about", () => {
    const rules = gitignore(["workspace-data/", "*.log", "*.tmp", "!keep.tmp"]);
    for (const path of PATHS) rules.ignores(path);
    expect(rules.unmatched()).toEqual(["*.tmp", "!keep.tmp"]);
  });

  it("counts a pattern as matching a file inside a folder another pattern left out", () => {
    const rules = gitignore(["notes/", "*.log"]);
    rules.ignores("notes/today.log");
    expect(rules.unmatched()).toEqual([]);
  });
});
