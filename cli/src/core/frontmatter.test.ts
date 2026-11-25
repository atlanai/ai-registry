import { describe, expect, test } from "vitest";
import { readFrontmatter } from "#adapter/layouts/frontmatter.ts";
import { frontmatter, markdownBody, withName } from "./frontmatter.ts";

// Windows PowerShell 5.1 and some editors save UTF-8 with a byte order mark.
const SAVED_WITH_BOM =
  "\uFEFF---\r\nname: pdf-tools\r\ndescription: Extract text.\r\n---\r\nBody.\r\n";

describe("frontmatter, for a file that starts with a byte order mark", () => {
  test("reads the fields, as the adapter's reader does", () => {
    expect(frontmatter(SAVED_WITH_BOM)).toEqual({
      name: "pdf-tools",
      description: "Extract text.",
      engine: undefined,
    });
    expect(readFrontmatter(SAVED_WITH_BOM)?.data).toMatchObject({
      name: "pdf-tools",
      description: "Extract text.",
    });
  });

  test("leaves the mark out of the body, and keeps it when renaming", () => {
    expect(markdownBody(SAVED_WITH_BOM)).toBe("Body.\r\n");
    expect(withName(SAVED_WITH_BOM, "pdf")).toBe(SAVED_WITH_BOM.replace("pdf-tools", "pdf"));
  });
});
