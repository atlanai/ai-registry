import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect } from "vitest";
import { skillFile, skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";

const PDF = { description: "Extract text from PDF files.", body: "Use pdftotext, then camelot.\n" };
const SQL = { description: "Find mistakes in SQL.", body: "Check every DELETE has a WHERE.\n" };
const REVIEW = { description: "Review a pull request.", body: "Read the diff, then the tests.\n" };
const TESTS = { description: "Write unit tests.", body: "One test per behavior.\n" };
const CSV = { description: "Clean a CSV file.", body: "Trim cells, then drop duplicate rows.\n" };
const CHECK = { description: "Check a deploy is safe.", body: "Run scripts/check.sh first.\n" };

interface Group {
  match: string;
  artifacts: { name: string; path: string; registry?: string }[];
}

describe("aireg status, for skills that are copies or share a name", () => {
  test("names each group once, and nothing that is only alike or a link", async ({
    aireg,
    home,
    tmp,
  }) => {
    const acme = await skillsFolder(join(tmp, "acme"))
      .skill("skills/pr-review", REVIEW)
      .skill("skills/sql-lint", SQL)
      .skill("skills/docker-debug", { description: "Debug a container.", body: "Read the logs.\n" })
      .write();
    const team = await skillsFolder(join(tmp, "team"))
      .skill("skills/code-review", REVIEW)
      .skill("skills/docker-deploy", {
        description: "Roll out an image.",
        body: "Push, then roll.\n",
      })
      .write();
    for (const registry of [acme, team]) {
      const added = await aireg(["add", registry, "--all", "-g", "-y"], { cwd: home.dir });
      expect(added.code, added.stderr).toBe(0);
    }
    await skillsFolder(home.dir)
      .skill(".claude/skills/pdf-tools", PDF)
      .skill(".claude/skills/pdf-helper", PDF)
      .skill(".claude/skills/sql-linter", SQL)
      .skill(".claude/skills/test-writer", TESTS)
      .skill(".claude/skills/csv-clean", CSV)
      .skill(".claude/skills/git-bisect", { description: "Find a bad commit.", body: "Bisect.\n" })
      .skill(".claude/skills/deploy-check", CHECK)
      .file(".claude/skills/deploy-check/scripts/check.sh", "#!/bin/sh\n")
      .skill(".agents/skills/pdf-tools", { description: "Fill PDF forms.", body: "Use pdftk.\n" })
      .skill(".agents/skills/test-writer", TESTS)
      .skill(".agents/skills/test-runner", { description: "Run the tests.", body: "Run them.\n" })
      .skill(".agents/skills/deploy-check-v2", CHECK)
      .file(
        ".agents/skills/csv-tidy/SKILL.md",
        skillFile("csv-tidy", CSV.description, CSV.body).replaceAll("\n", "\r\n"),
      )
      .write();
    await mkdir(join(home.dir, ".agents", "skills"), { recursive: true });
    await symlink(
      join(home.dir, ".claude", "skills", "git-bisect"),
      join(home.dir, ".agents", "skills", "git-bisect"),
    );

    const ran = await aireg(["status", "-g", "--json"], { cwd: home.dir });
    expect(ran.code, ran.stderr).toBe(0);
    // Real paths, so a temporary folder behind a link, as on macOS, still reads under the home.
    const real = realpathSync(home.dir);
    const where = (copy: Group["artifacts"][number]) =>
      copy.registry ?? relative(real, copy.path).split(sep).join("/");
    const groups = (JSON.parse(ran.stdout).data.duplicates as Group[]).map((group) => [
      group.match,
      ...group.artifacts.map((copy) => `${copy.name} ${where(copy)}`),
    ]);
    expect(groups).toEqual([
      ["identical", "code-review team", "pr-review acme"],
      ["identical", "csv-clean .claude/skills/csv-clean", "csv-tidy .agents/skills/csv-tidy"],
      ["identical", "pdf-helper .claude/skills/pdf-helper", "pdf-tools .claude/skills/pdf-tools"],
      ["identical", "sql-lint acme", "sql-linter .claude/skills/sql-linter"],
      [
        "identical",
        "test-writer .agents/skills/test-writer",
        "test-writer .claude/skills/test-writer",
      ],
      ["name", "pdf-tools .agents/skills/pdf-tools", "pdf-tools .claude/skills/pdf-tools"],
    ]);

    const text = await aireg(["status", "-g"], { cwd: home.dir });
    expect(text.stdout).toContain("6 duplicates");
    expect(text.stdout).toMatch(
      /identical\s+code-review\s+installed from team\n\s+pr-review\s+installed from acme/,
    );
    expect(text.stdout).toMatch(/same name\s+pdf-tools\s+~\/\.agents\/skills\/pdf-tools/);
  });

  test("prints no duplicates section when every skill is its own", async ({ aireg, home }) => {
    for (const name of ["notes", "todo"]) {
      await mkdir(join(home.dir, ".claude", "skills", name), { recursive: true });
      await writeFile(join(home.dir, ".claude", "skills", name, "SKILL.md"), skillFile(name));
    }
    const ran = await aireg(["status", "-g"], { cwd: home.dir });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("2 unmanaged");
    expect(ran.stdout).not.toContain("duplicate");
  });
});
