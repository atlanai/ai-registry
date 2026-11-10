import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { type Copy, duplicates } from "./duplicates.ts";

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Extract text from PDF files.\n---\n\n${body}\n`;
const EXTRACT = "Use pdftotext with the layout flag, then camelot for tables.";

/** A skill folder at `root/<at>`, with its SKILL.md and any other files. */
async function folder(
  root: string,
  at: string,
  files: Record<string, string>,
  registry?: string,
): Promise<Copy> {
  const path = join(root, at);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(path, file, ".."), { recursive: true });
    await writeFile(join(path, file), text);
  }
  const name = /^name: (.*)$/m.exec(files["SKILL.md"] ?? "")?.[1] ?? at;
  return { name, path, ...(registry === undefined ? {} : { registry }) };
}

describe("duplicates", () => {
  test("groups copies whose files match, whatever their names and line endings", async ({
    tmp,
  }) => {
    const tools = await folder(tmp, "a/pdf-tools", { "SKILL.md": skill("pdf-tools", EXTRACT) });
    const helper = await folder(tmp, "b/pdf-helper", {
      "SKILL.md": skill("pdf-helper", EXTRACT).replaceAll("\n", "\r\n"),
    });

    expect(await duplicates([], [tools, helper])).toEqual([
      { match: "identical", artifacts: [helper, tools] },
    ]);
  });

  test("keeps copies apart once any other line or file differs", async ({ tmp }) => {
    const base = await folder(tmp, "a/check", { "SKILL.md": skill("check", EXTRACT) });
    const edited = await folder(tmp, "b/check-edited", {
      "SKILL.md": skill("check-edited", `${EXTRACT} Then stop.`),
    });
    const scripted = await folder(tmp, "c/check-scripted", {
      "SKILL.md": skill("check-scripted", EXTRACT),
      "scripts/check.sh": "#!/bin/sh\n",
    });

    expect(await duplicates([], [base, edited, scripted])).toEqual([]);
  });

  test("matches an installed copy without the envelope its store keeps", async ({ tmp }) => {
    const installed = await folder(
      tmp,
      "store/sql-lint",
      { "SKILL.md": skill("sql-lint", EXTRACT), "artifact.json": "{}\n" },
      "acme",
    );
    const mine = await folder(tmp, "claude/sql-linter", {
      "SKILL.md": skill("sql-linter", EXTRACT),
    });

    expect(await duplicates([installed], [mine])).toEqual([
      { match: "identical", artifacts: [installed, mine] },
    ]);
  });

  test("names unmanaged skills that share a name but not their files", async ({ tmp }) => {
    const extract = await folder(tmp, "claude/pdf-tools", {
      "SKILL.md": skill("pdf-tools", EXTRACT),
    });
    const forms = await folder(tmp, "agents/pdf-tools", {
      "SKILL.md": skill("pdf-tools", "Fill AcroForm fields with pdftk, then flatten."),
    });

    expect(await duplicates([], [extract, forms])).toEqual([
      { match: "name", artifacts: [forms, extract] },
    ]);
  });

  test("reports copies of one name with matching files as identical only", async ({ tmp }) => {
    const one = await folder(tmp, "claude/test-writer", {
      "SKILL.md": skill("test-writer", EXTRACT),
    });
    const two = await folder(tmp, "agents/test-writer", {
      "SKILL.md": skill("test-writer", EXTRACT),
    });

    expect(await duplicates([], [one, two])).toEqual([
      { match: "identical", artifacts: [two, one] },
    ]);
  });

  test("leaves installed skills out of a name match, which installing already refuses", async ({
    tmp,
  }) => {
    const installed = await folder(
      tmp,
      "store/pr-review",
      { "SKILL.md": skill("pr-review", EXTRACT) },
      "acme",
    );
    const mine = await folder(tmp, "cursor/pr-review", {
      "SKILL.md": skill("pr-review", "Review the diff for risk."),
    });

    expect(await duplicates([installed], [mine])).toEqual([]);
  });

  test("lists name matches after identical ones, each in a stable order", async ({ tmp }) => {
    const forms = await folder(tmp, "agents/pdf-tools", {
      "SKILL.md": skill("pdf-tools", "Fill forms."),
    });
    const extract = await folder(tmp, "claude/pdf-tools", {
      "SKILL.md": skill("pdf-tools", EXTRACT),
    });
    const helper = await folder(tmp, "claude/pdf-helper", {
      "SKILL.md": skill("pdf-helper", EXTRACT),
    });
    const zeta = await folder(tmp, "claude/zeta", { "SKILL.md": skill("zeta", "Zeta.") });
    const zed = await folder(tmp, "agents/zed", { "SKILL.md": skill("zed", "Zeta.") });

    const found = await duplicates([], [zeta, forms, extract, zed, helper]);
    expect(found).toEqual([
      { match: "identical", artifacts: [helper, extract] },
      { match: "identical", artifacts: [zed, zeta] },
      { match: "name", artifacts: [forms, extract] },
    ]);
  });
});
