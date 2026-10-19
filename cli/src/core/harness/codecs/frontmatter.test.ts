import { describe, expect, it } from "vitest";
import type { Codec } from "#core/harness/contract.ts";
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
  it("keeps only the keys it lists, with their comments and order", () => {
    const out = applyCodec(
      { id: "frontmatter-strict", keep: ["name", "description", "tools"] },
      AGENT,
      "r",
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

  it("refuses to drop a restriction rather than widen what the agent may do", () => {
    const codec: Codec = {
      id: "frontmatter-strict",
      keep: ["name", "description"],
      restrictions: ["tools"],
    };
    expect(applyCodec(codec, AGENT, "r")).toEqual({
      problem: "it sets tools, which this harness cannot read",
    });
  });
});

describe("frontmatter-set", () => {
  it("adds fixed keys and overrides one already set", () => {
    const out = applyCodec(
      { id: "frontmatter-set", set: { mode: "subagent", color: "red" } },
      AGENT,
      "r",
    );
    expect(out).toEqual({ text: expect.stringContaining("color: red\nmode: subagent\n---\n") });
  });

  it("refuses to change a restriction the artifact sets", () => {
    const codec: Codec = { id: "frontmatter-set", set: { tools: "*" }, restrictions: ["tools"] };
    expect(applyCodec(codec, AGENT, "r")).toEqual({
      problem: "it sets tools, which this harness would change",
    });
  });
});

describe("command-skill", () => {
  it("names the skill for its plugin and leaves invoking it to a person", () => {
    const command =
      "---\ndescription: Ship it.\nallowed-tools: Bash(git:*)\n---\nShip $ARGUMENTS.\n";
    expect(applyCodec({ id: "command-skill" }, command, "kit-ship")).toEqual({
      text: [
        "---",
        "description: Ship it.",
        "allowed-tools: Bash(git:*)",
        "name: kit-ship",
        "disable-model-invocation: true",
        "---",
        "Ship $ARGUMENTS.",
        "",
      ].join("\n"),
    });
  });

  it("refuses a command with no description, which a skill needs", () => {
    const command = "---\nargument-hint: <branch>\n---\nShip it.\n";
    expect(applyCodec({ id: "command-skill" }, command, "kit-ship")).toEqual({
      problem: "it has no description",
    });
  });
});
