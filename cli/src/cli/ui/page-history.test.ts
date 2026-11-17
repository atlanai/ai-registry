import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { Catalogs } from "#cli/catalog/registries.ts";
import { CatalogReader } from "#cli/catalog/state.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { Printer } from "#core/term/printer.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";

function context(cwd: string, code: string): CommandContext {
  return {
    argv: [],
    cwd,
    printer: new Printer(),
    host: {
      version: "0.0.0",
      connectAccount: async () => {
        throw new Error("No account should be opened.");
      },
      openRunStore: async () => {
        throw Object.assign(new Error("Database unavailable"), { code });
      },
    },
  };
}

test("a restricted history database does not hide skills on this machine", async ({
  home,
  project,
}) => {
  const folder = join(home.dir, ".claude", "skills", "sample-skill");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: sample-skill\ndescription: A sample local skill.\n---\n# Sample\nRead the input.",
  );
  const input = context(project, "EPERM");
  const state = await new CatalogReader(input, new Catalogs(input)).read();
  expect(state.artifacts.some((artifact) => artifact.name === "sample-skill")).toBe(true);
  expect(state.problems).toContainEqual(expect.stringContaining("Run history is unavailable"));
  expect(state.console.runs).toEqual([]);
});

test("unexpected database errors are not silently replaced with empty history", async ({
  project,
}) => {
  const input = context(project, "UNEXPECTED");
  await expect(new CatalogReader(input, new Catalogs(input)).read()).rejects.toThrow(
    "Database unavailable",
  );
});
