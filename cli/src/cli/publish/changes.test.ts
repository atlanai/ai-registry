import { describe, expect, it } from "vitest";
import { changeLines, changesFrom } from "./changes.ts";

const file = (path: string, digest = `sha256:${path}`) => ({ path, digest });
const edge = (to: string) => ({ rel_type: "depends_on", to });

describe("changesFrom", () => {
  it("names each file added, changed and removed, and each edge whose `to` moved", () => {
    const held = {
      files: [file("AGENT.md"), file("identity/SOUL.md"), file("identity/MEMORY.md")],
      relationships: [edge("eng/skill/review@0.1.0"), edge("eng/skill/lint@1.0.0")],
    };
    const sent = {
      files: [file("AGENT.md"), file("identity/SOUL.md", "sha256:new"), file("workspace/NEW.md")],
      relationships: [edge("eng/skill/review@0.1.1"), edge("eng/skill/lint@1.0.0")],
    };
    expect(changesFrom(held, sent)).toEqual({
      files: {
        added: ["workspace/NEW.md"],
        changed: ["identity/SOUL.md"],
        removed: ["identity/MEMORY.md"],
      },
      dependsOn: { added: ["eng/skill/review@0.1.1"], removed: ["eng/skill/review@0.1.0"] },
    });
  });

  it("compares a sole entry by content when the registry names it AGENT.md", () => {
    const held = { files: [file("AGENT.md", "sha256:same")] };
    expect(changesFrom(held, { files: [file("reviewer.md", "sha256:same")] }).files).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(changesFrom(held, { files: [file("reviewer.md", "sha256:new")] }).files).toEqual({
      added: [],
      changed: ["reviewer.md"],
      removed: [],
    });
  });

  it("adds everything when no version is held, and counts only depends_on edges", () => {
    const sent = {
      files: [file("SKILL.md"), file("a.md")],
      relationships: [edge("eng/skill/b@1.0.0"), { rel_type: "related", to: "eng/skill/c@1.0.0" }],
    };
    expect(changesFrom(undefined, sent)).toEqual({
      files: { added: ["SKILL.md", "a.md"], changed: [], removed: [] },
      dependsOn: { added: ["eng/skill/b@1.0.0"], removed: [] },
    });
  });
});

describe("changeLines", () => {
  it("lists at most ten lines, the last saying how many more", () => {
    const many = Array.from({ length: 12 }, (_, at) => file(`f${String(at).padStart(2, "0")}.md`));
    const lines = changeLines(changesFrom(undefined, { files: many }));
    expect(lines).toHaveLength(10);
    expect(lines.at(-2)).toBe("    added    f08.md");
    expect(lines.at(-1)).toBe("    and 3 more");
    expect(changeLines(changesFrom(undefined, { files: many.slice(0, 10) }))).toHaveLength(10);
  });

  it("prints a path the registry gives safely", () => {
    const changes = changesFrom({ files: [file("evil\u001b[2J.md")] }, { files: [] });
    expect(changeLines(changes)).toEqual(["    removed  evil.md"]);
  });
});
