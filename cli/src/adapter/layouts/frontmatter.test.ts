import { describe, expect, it } from "vitest";
import { readFrontmatter, textField } from "./frontmatter.ts";

describe("readFrontmatter", () => {
  it("reads top-level text, quoted or not, and keeps the body", () => {
    const read = readFrontmatter(
      [
        "---",
        "name: pdf",
        "description: Fill PDF forms # with a comment",
        "title: 'It''s quoted'",
        'tagline: "Line one\\nline two"',
        "url: https://example.test/a#b",
        "---",
        "# Body",
        "",
      ].join("\n"),
    );
    expect(read?.data).toEqual({
      name: "pdf",
      description: "Fill PDF forms",
      title: "It's quoted",
      tagline: "Line one\nline two",
      url: "https://example.test/a#b",
    });
    expect(read?.body).toBe("# Body\n");
  });

  it("reads block scalars, lists and one level of keys", () => {
    const read = readFrontmatter(
      [
        "---",
        "description: |",
        "  First line.",
        "  Second line.",
        "summary: >-",
        "  Folded",
        "  together.",
        "tools:",
        "  - Read",
        "  - 'Write'",
        "inline: [a, 'b']",
        "metadata:",
        "  version: 1.2.0",
        "  owner: platform",
        "---",
      ].join("\n"),
    );
    expect(read?.data).toEqual({
      description: "First line.\nSecond line.\n",
      summary: "Folded together.",
      tools: ["Read", "Write"],
      inline: ["a", "b"],
      metadata: { version: "1.2.0", owner: "platform" },
    });
  });

  it("is undefined without a front matter block, and skips what it does not cover", () => {
    expect(readFrontmatter("# Just a body\n")).toBeUndefined();
    expect(readFrontmatter("---\nname: open\n")).toBeUndefined();
    const read = readFrontmatter("﻿---\r\nname: x\r\nanchor: &a value\r\n  - stray\r\n---\r\n");
    expect(read?.data).toEqual({ name: "x" });
    expect(textField(read, "name")).toBe("x");
    expect(textField(read, "missing")).toBeUndefined();
  });

  it("never evaluates what it reads", () => {
    const read = readFrontmatter("---\nname: !!js/function 'function () {}'\nother: {a: 1}\n---\n");
    expect(read?.data).toEqual({});
  });
});
