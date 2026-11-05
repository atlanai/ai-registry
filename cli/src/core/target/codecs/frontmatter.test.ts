import { describe, expect, test } from "vitest";
import type { Codec } from "#core/target/contract.ts";
import { applyCodec } from "./index.ts";

const AGENT = [
  "---",
  "# reviewed weekly",
  "name: reviewer",
  "description: Reviews code.",
  "tools: Read, Grep",
  "color: cyan",
  "---",
  "Review the diff.",
  "",
].join("\n");

describe("frontmatter-strict", () => {
  test("keeps only the keys it lists, with their comments and order", () => {
    const out = applyCodec(
      { id: "frontmatter-strict", keep: ["name", "description", "tools"] },
      AGENT,
    );
    expect(out).toEqual({
      text: [
        "---",
        "# reviewed weekly",
        "name: reviewer",
        "description: Reviews code.",
        "tools: Read, Grep",
        "---",
        "Review the diff.",
        "",
      ].join("\n"),
    });
  });

  test("refuses to drop a key that limits the agent, rather than widen what it may do", () => {
    const codec: Codec = { id: "frontmatter-strict", keep: ["name", "description"] };
    expect(applyCodec(codec, AGENT)).toEqual({
      problem: "it sets tools, which this target cannot read",
    });
  });

  test("refuses to drop a key its definition lists as a restriction", () => {
    const keep = ["name", "description", "tools"];
    const codec: Codec = { id: "frontmatter-strict", keep, restrictions: ["color"] };
    expect(applyCodec(codec, AGENT)).toEqual({
      problem: "it sets color, which this target cannot read",
    });
  });
});

describe("frontmatter-set", () => {
  test("adds fixed keys and overrides one already set", () => {
    const out = applyCodec(
      { id: "frontmatter-set", set: { mode: "subagent", color: "red" } },
      AGENT,
    );
    expect(out).toEqual({ text: expect.stringContaining("color: red\nmode: subagent\n---\n") });
  });

  test("refuses to change a restriction the artifact sets", () => {
    const codec: Codec = { id: "frontmatter-set", set: { tools: "*" } };
    expect(applyCodec(codec, AGENT)).toEqual({
      problem: "it sets tools, which this target would change",
    });
  });
});
