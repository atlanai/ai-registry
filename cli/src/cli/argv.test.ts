import { describe, expect, it } from "vitest";
import { builtin } from "#cli/commands/index.ts";
import { ErrorCode } from "#core/errors.ts";
import { colorWhen, findCommand, misplacedOption, misusedGlobal, readGlobals } from "./argv.ts";

describe("findCommand", () => {
  it.each([
    { argv: [], index: -1 },
    { argv: ["add", "x"], index: 0 },
    { argv: ["--json", "add"], index: 1 },
    { argv: ["-q", "list"], index: 1 },
    { argv: ["--log-level", "debug", "add", "x"], index: 2 },
    { argv: ["--color", "never", "targets"], index: 2 },
    { argv: ["--color=never", "targets"], index: 1 },
    { argv: ["--map"], index: -1 },
    { argv: ["--map", "json"], index: -1 },
    { argv: ["--map", "add"], index: 1 },
    { argv: ["--dry-run", "install"], index: 1 },
    { argv: ["--for", "claude", "add", "kit"], index: 1 },
  ])("finds $index in $argv", ({ argv, index }) => {
    expect(findCommand(argv)).toBe(index);
  });
});

describe("readGlobals", () => {
  it.each([
    { argv: ["--json", "list"], command: "list", values: { json: true }, rest: [] },
    {
      argv: ["list", "--json", "-q"],
      command: "list",
      values: { json: true, quiet: true },
      rest: [],
    },
    {
      argv: ["--log-level", "debug", "add", "x"],
      command: "add",
      values: { "log-level": "debug" },
      rest: ["x"],
    },
    {
      argv: ["targets", "--color=always"],
      command: "targets",
      values: { color: "always" },
      rest: [],
    },
    {
      argv: ["targets", "--no-color"],
      command: "targets",
      values: { "no-color": true },
      rest: [],
    },
    // The command's own options decide which words are values, so `-m "-v"` is not --version.
    {
      argv: ["publish", "-m", "-v"],
      command: "publish",
      values: {},
      rest: ["-m", "-v"],
    },
    { argv: ["-v"], command: undefined, values: { version: true }, rest: [] },
    { argv: ["-h", "add"], command: "add", values: { help: true }, rest: [] },
  ])("reads $argv", ({ argv, command, values, rest }) => {
    const index = findCommand(argv);
    const read = readGlobals(argv, index, command === undefined ? undefined : builtin(command));
    expect(read.values).toEqual(values);
    expect(read.rest).toEqual(rest);
  });
});

describe("misusedGlobal", () => {
  it.each([
    {
      values: { quiet: true, verbose: true },
      message: "--quiet and --verbose cannot be used together.",
    },
    { values: { "log-level": true }, message: "--log-level needs a value." },
    {
      values: { "log-level": "list" },
      message: '--log-level takes trace, debug, info, warn, error, fatal or off, not "list".',
    },
    { values: { color: "blue" }, message: '--color takes auto, always or never, not "blue".' },
    { values: { color: true }, message: "--color needs a value." },
    {
      values: { color: "never", "no-color": true },
      message: "--color and --no-color cannot be used together.",
    },
  ])("refuses $values", ({ values, message }) => {
    expect(misusedGlobal(values)).toMatchObject({ code: ErrorCode.Usage, message });
  });

  it.each([
    {},
    { color: "always" },
    { quiet: true },
    { "log-level": "debug" },
    { "log-level": "OFF" },
  ])("accepts %o", (values) => {
    expect(misusedGlobal(values)).toBeUndefined();
  });
});

describe("colorWhen", () => {
  it.each([
    { values: {}, when: "auto" },
    { values: { "no-color": true }, when: "never" },
    { values: { color: "always" }, when: "always" },
    { values: { color: "never" }, when: "never" },
    { values: { color: "blue" }, when: "auto" },
  ])("is $when for $values", ({ values, when }) => {
    expect(colorWhen(values)).toBe(when);
  });
});

describe("misplacedOption", () => {
  const known = async (name: string) => ["add", "install", "list", "remove"].includes(name);

  it.each([["add", "--json"], ["--json", "add"], ["--log-level", "debug", "list"], ["list"], []])(
    "accepts %j",
    async (...argv) => {
      expect(await misplacedOption(argv, findCommand(argv), known)).toBeUndefined();
    },
  );

  it.each([
    {
      argv: ["--dry-run", "install"],
      message: "--dry-run must come after the command name.",
      fix: "aireg install --dry-run",
    },
    {
      argv: ["-g", "remove", "lint", "-y"],
      message: "-g must come after the command name.",
      fix: "aireg remove -g lint -y",
    },
    {
      argv: ["--color", "never", "-g", "list"],
      message: "-g must come after the command name.",
      fix: "aireg --color never list -g",
    },
    { argv: ["--dry-run=yes", "add"], message: "--dry-run must come after the command name." },
  ])("moves $argv after the command", async ({ argv, message, fix }) => {
    const error = await misplacedOption(argv, findCommand(argv), known);
    expect(error).toMatchObject({ code: ErrorCode.Usage, message });
    if (fix !== undefined) expect(error?.hint).toContain(`Did you mean \`${fix}\`?`);
  });

  // `--for claude add` makes `claude` the command, so no fix is offered for it.
  it.each([["--for", "claude", "add", "kit"], ["--frozen"]])(
    "offers no fix for %j",
    async (...argv) => {
      const error = await misplacedOption(argv, findCommand(argv), known);
      expect(error?.code).toBe(ErrorCode.Usage);
      expect(error?.hint).not.toContain("Did you mean");
      expect(error?.hint).toContain("--json");
    },
  );
});
