import { expect, test } from "vitest";
import { frontmatter, markdownBody, withName } from "./frontmatter.ts";

const SAVED_WITH_BOM =
  "\uFEFF---\r\nname: pdf-tools\r\ndescription: Extract text.\r\n---\r\nBody.\r\n";

test("reads front matter after a byte order mark", () => {
  expect(frontmatter(SAVED_WITH_BOM)).toEqual({
    name: "pdf-tools",
    description: "Extract text.",
    engine: undefined,
  });
  expect(markdownBody(SAVED_WITH_BOM)).toBe("Body.\r\n");
  expect(withName(SAVED_WITH_BOM, "pdf")).toBe(SAVED_WITH_BOM.replace("pdf-tools", "pdf"));
});
