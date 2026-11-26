import { describe, expect, test } from "vitest";
import { readFrontmatter } from "#adapter/layouts/frontmatter.ts";
import { frontmatter, markdownBody, splitFrontmatter, withName } from "./frontmatter.ts";

// An editor that keeps trailing whitespace can leave a space or a tab after either fence.
const FILES: [string, string, string][] = [
  [
    "a space after each fence",
    "--- \nname: pdf-tools\ndescription: Extract text.\n--- \nBody.\n",
    "Body.\n",
  ],
  [
    "a tab after each fence",
    "---\t\nname: pdf-tools\ndescription: Extract text.\n---\t\nBody.\n",
    "Body.\n",
  ],
  [
    "CRLF lines and mixed whitespace",
    "--- \t\r\nname: pdf-tools\r\ndescription: Extract text.\r\n---  \r\nBody.\r\n",
    "Body.\r\n",
  ],
  [
    "whitespace after a closing fence that ends the file",
    "---\nname: pdf-tools\ndescription: Extract text.\n--- ",
    "",
  ],
];

describe.each(FILES)("frontmatter, for %s", (_, text, body) => {
  test("reads the fields, as the adapter's reader does", () => {
    expect(frontmatter(text)).toEqual({
      name: "pdf-tools",
      description: "Extract text.",
      engine: undefined,
    });
    expect(readFrontmatter(text)?.data).toMatchObject({
      name: "pdf-tools",
      description: "Extract text.",
    });
  });

  test("leaves the fences out of the body", () => {
    expect(markdownBody(text)).toBe(body);
    expect(splitFrontmatter(text)?.body).toBe(body);
  });

  test("renames without touching the fences", () => {
    expect(withName(text, "pdf")).toBe(text.replace("name: pdf-tools", "name: pdf"));
  });
});

test("a fence followed by other text still opens no front matter", () => {
  const text = "--- x\nname: pdf-tools\n---\nBody.\n";
  expect(frontmatter(text).name).toBeUndefined();
  expect(markdownBody(text)).toBe(text);
});
