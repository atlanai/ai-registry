import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { GLOBAL_OPTIONS } from "#cli/options/flags.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import type { CommandSpec } from "./command.ts";
import { COMMANDS } from "./index.ts";

const REFERENCE = new URL("../../../../docs/reference/", import.meta.url);

function page(name: string): string {
  return readFileSync(new URL(`${name}.md`, REFERENCE), "utf8");
}

const INDEX = page("index");
const shown = COMMANDS;
const GLOBAL = new Set(GLOBAL_OPTIONS.map((option) => option.flag));

function optionsOf(command: CommandSpec): OptionSpec[] {
  return [
    ...(command.options ?? []),
    ...(command.actions ?? []).flatMap((action) => action.options ?? []),
  ].filter((option) => !GLOBAL.has(option.flag));
}

/** A page may name a shared option by its short form, as `-g`. */
function named(text: string, option: OptionSpec): boolean {
  return [option.flag, option.short].some(
    (name) => name !== undefined && text.includes(`\`${name}`),
  );
}

describe("the reference docs", () => {
  test.each(shown.map((command) => [command.name, command] as const))(
    "has a page for %s",
    (_, command) => {
      expect(command.docs, "a docs page").toBeDefined();
      expect(existsSync(new URL(`${command.docs}.md`, REFERENCE))).toBe(true);
    },
  );

  test.each(shown.map((command) => [command.name, command] as const))(
    "lists %s in the index with its summary",
    (_, command) => {
      const row = INDEX.split("\n").find((line) => line.includes(`](${command.docs}.md)`));
      expect(row, `a row linking ${command.docs}.md`).toBeDefined();
      expect(row).toContain(`| ${command.summary}. |`);
    },
  );

  test.each(shown.map((command) => [command.name, command] as const))(
    "documents every option of %s on its page",
    (_, command) => {
      const text = page(command.docs as string);
      const missing = optionsOf(command).filter((option) => !named(text, option));
      expect([...new Set(missing.map((option) => option.flag))]).toEqual([]);
    },
  );
});
