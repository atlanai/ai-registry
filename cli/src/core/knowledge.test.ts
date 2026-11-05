import { describe, expect, test } from "vitest";
import { isConceptPath, KNOWLEDGE_LIMITS, knowledgeProblems } from "./knowledge.ts";

const file = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text) });
const concept = (path: string, type = "Contract") => file(path, `---\ntype: ${type}\n---\nBody.\n`);

describe("knowledgeProblems", () => {
  test("takes a bundle of concepts, reserved files and other files as written", () => {
    expect(
      knowledgeProblems([
        concept("contracts/routing.json.md"),
        file("contracts/routing.json", '{"routes": []}'),
        file("sql/deal_state.sql", "select 1;"),
        file("index.md", "# Contents\n"),
        file("sql/log.md", "# Log\n"),
        file("notes.md", "\uFEFF---\r\ntype: Guide\r\n---\r\nWindows lines.\r\n"),
      ]),
    ).toEqual([]);
  });

  test("names each concept without front matter, without a type, or with a block that is not YAML", () => {
    expect(
      knowledgeProblems([
        file("a.md", "No front matter.\n"),
        file("b.md", "---\ntitle: Untyped\n---\n"),
        file("c.md", "---\ntype: '  '\n---\n"),
        file("d.md", "---\n---\n"),
        file("e.md", "---\ntype: [unclosed\n---\n"),
        file("f.md", "---\n- a list\n---\n"),
        file("g.md", "---\ntype: Guide\nnever closed\n"),
      ]),
    ).toEqual([
      "a.md has no `---` delimited YAML front matter (Open Knowledge Format v0.2 §4.1)",
      "b.md has front matter without a non-empty `type` (Open Knowledge Format v0.2 §11.2)",
      "c.md has front matter without a non-empty `type` (Open Knowledge Format v0.2 §11.2)",
      "d.md has front matter without a non-empty `type` (Open Knowledge Format v0.2 §11.2)",
      "e.md has front matter that is not YAML (Open Knowledge Format v0.2 §11.1)",
      "f.md has front matter that is not a YAML mapping (Open Knowledge Format v0.2 §11.1)",
      "g.md has no `---` delimited YAML front matter (Open Knowledge Format v0.2 §4.1)",
    ]);
  });

  test("refuses a concept that is not UTF-8", () => {
    const bytes = { path: "latin.md", content: Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff]) };
    expect(knowledgeProblems([bytes])).toEqual([
      "latin.md is not UTF-8 text (Open Knowledge Format v0.2 §4)",
    ]);
  });

  test("refuses unsafe, long and deep paths, and the root download names", () => {
    const deep = `${Array.from({ length: KNOWLEDGE_LIMITS.depth }, (_, i) => `d${i}`).join("/")}/x.sql`;
    expect(
      knowledgeProblems([
        file("../escape.sql", ""),
        file("a//b.sql", ""),
        file(`${"x".repeat(KNOWLEDGE_LIMITS.pathBytes)}.sql`, ""),
        file(deep, ""),
        file("bundle.zip", ""),
        file("bundle.tar.gz", ""),
        file("nested/bundle.zip", ""),
      ]),
    ).toEqual([
      "../escape.sql is not a safe path relative to the bundle",
      "a//b.sql is not a safe path relative to the bundle",
      `${"x".repeat(KNOWLEDGE_LIMITS.pathBytes)}.sql is longer than ${KNOWLEDGE_LIMITS.pathBytes} bytes`,
      `${deep} is nested deeper than ${KNOWLEDGE_LIMITS.depth} levels`,
      "bundle.zip is reserved for the bundle's own download",
      "bundle.tar.gz is reserved for the bundle's own download",
    ]);
  });

  test("refuses an empty bundle and one over its file or byte ceilings", () => {
    expect(knowledgeProblems([])).toEqual(["holds no files"]);
    const many = Array.from({ length: KNOWLEDGE_LIMITS.entries + 1 }, (_, i) =>
      file(`f${i}.sql`, ""),
    );
    expect(knowledgeProblems(many)).toEqual([
      `holds ${KNOWLEDGE_LIMITS.entries + 1} files, more than ${KNOWLEDGE_LIMITS.entries}`,
    ]);
    const big = { path: "big.sql", content: new Uint8Array(KNOWLEDGE_LIMITS.totalBytes + 1) };
    expect(knowledgeProblems([big])).toEqual([
      `holds ${KNOWLEDGE_LIMITS.totalBytes + 1} bytes, more than ${KNOWLEDGE_LIMITS.totalBytes}`,
    ]);
  });
});

describe("isConceptPath", () => {
  test("is Markdown that is not a directory's index or log", () => {
    expect(isConceptPath("contracts/routing.json.md")).toBe(true);
    expect(isConceptPath("tables/index.md")).toBe(false);
    expect(isConceptPath("log.md")).toBe(false);
    expect(isConceptPath("contracts/routing.json")).toBe(false);
  });
});
