import { describe, expect, test } from "vitest";
import type { Codec } from "#core/target/contract.ts";
import { applyCodec } from "./index.ts";

const AGENT: Codec = {
  id: "frontmatter-toml",
  fields: ["name", "description"],
  body: "developer_instructions",
};

const agent = (front: string, body: string) => `---\n${front}\n---\n${body}`;

describe("frontmatter-toml", () => {
  test("keeps the fields it names and the body, and leaves out any other front matter", () => {
    const source = agent(
      "name: reviewer\ndescription: Reviews code.\nmodel: sonnet\ncolor: cyan",
      "\n# Reviewer\n\nReview the diff.\n",
    );
    expect(applyCodec(AGENT, source)).toEqual({
      text: [
        'name = "reviewer"',
        'description = "Reviews code."',
        'developer_instructions = """',
        '# Reviewer\n\nReview the diff."""',
        "",
      ].join("\n"),
    });
  });

  test("escapes backslashes, control characters and runs of quotes, and keeps unicode", () => {
    const body =
      'Say """hi""" to C:\\temp\\new.\r\nTab\there, bell\u0007, caf\u00e9 \u{1F600}.\r\nEnd "quoted""';
    const out = applyCodec(AGENT, agent('name: r\ndescription: "A \\"quoted\\" one"', body));
    expect(out).toEqual({
      text: [
        'name = "r"',
        'description = "A \\"quoted\\" one"',
        'developer_instructions = """',
        'Say ""\\"hi""\\" to C:\\\\temp\\\\new.\nTab\there, bell\\u0007, caf\u00e9 \u{1F600}.\nEnd "quoted\\"\\""""',
        "",
      ].join("\n"),
    });
  });

  test("writes a multi-line description as one escaped line, as YAML reads it", () => {
    const out = applyCodec(AGENT, agent("name: r\ndescription: |\n  Two\n  lines", "Go."));
    expect(out).toMatchObject({
      text: expect.stringContaining('description = "Two\\nlines\\n"\n'),
    });
  });

  test.each([
    ["tools", "tools: Read, Grep"],
    ["disallowedTools", "disallowedTools: Edit"],
    ["permissionMode", "permissionMode: plan"],
  ])("refuses to drop %s, rather than widen what the agent may do", (key, line) => {
    const source = agent(`name: reviewer\ndescription: Reviews code.\n${line}`, "Review.");
    expect(applyCodec(AGENT, source)).toEqual({
      problem: `it sets ${key}, which this target cannot read`,
    });
  });

  test("keeps a limiting key it names as a field", () => {
    const codec: Codec = { ...AGENT, fields: ["name", "description", "tools"] };
    const source = agent("name: r\ndescription: d\ntools: Read", "Go.");
    expect(applyCodec(codec, source)).toMatchObject({
      text: expect.stringContaining('tools = "Read"\n'),
    });
  });

  test.each([
    ["no front matter", "Just text.", "it has no front matter"],
    ["a missing field", agent("name: r", "Go."), "it has no description"],
    [
      "a field that is not text",
      agent("name: r\ndescription: [a]", "Go."),
      "it has no description",
    ],
    ["an empty body", agent("name: r\ndescription: d", "\n \r\n"), "it has no instructions"],
  ])("refuses %s", (_, source, problem) => {
    expect(applyCodec(AGENT, source)).toEqual({ problem });
  });
});
