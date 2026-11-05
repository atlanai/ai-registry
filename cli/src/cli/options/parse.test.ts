import { describe, expect, test } from "vitest";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { AS } from "./flags.ts";
import { type Accepts, needsInput, parse } from "./parse.ts";

const GROUP: Accepts = {
  name: "group",
  actions: [
    { name: "list", aliases: ["ls"], maxArguments: 0 },
    { name: "get", maxArguments: 1 },
    { name: "set", maxArguments: 2 },
    { name: "any" },
  ],
};

function refusal(argv: string[], accepts: Accepts = GROUP): AiregError {
  try {
    parse(argv, accepts);
  } catch (error) {
    if (error instanceof AiregError) return error;
    throw error;
  }
  throw new Error(`parse accepted ${argv.join(" ")}`);
}

describe("parse, for an action's arguments", () => {
  test("takes up to as many words as the action declares", () => {
    expect(parse(["list"], GROUP).positionals).toEqual(["list"]);
    expect(parse(["get", "a"], GROUP).positionals).toEqual(["get", "a"]);
    expect(parse(["set", "a", "b"], GROUP).positionals).toEqual(["set", "a", "b"]);
    expect(parse(["any", "a", "b", "c"], GROUP).positionals).toEqual(["any", "a", "b", "c"]);
  });

  test("refuses a word after an action that takes none", () => {
    const error = refusal(["list", "zz", "more"]);
    expect(error.code).toBe(ErrorCode.Usage);
    expect(error.message).toBe('`aireg group list` takes no argument, not "zz".');
    expect(error.hint).toBe("Run `aireg group list --help` for its usage.");
  });

  test("checks an action that parses on its own", () => {
    const error = refusal(["v1", "v2"], { name: "self update", maxArguments: 1 });
    expect(error.code).toBe(ErrorCode.Usage);
    expect(error.message).toContain('not also "v2"');
  });

  test("escapes what it echoes", () => {
    expect(refusal(["list", "a\u202Eb"]).message).toContain('"a\\u202Eb"');
  });
});

describe("parse, for an action's aliases", () => {
  test("hands the command the action's name for an alias", () => {
    expect(parse(["ls"], GROUP).positionals).toEqual(["list"]);
  });
});

describe("parse, for --as", () => {
  const ADD: Accepts = { name: "registry", actions: [{ name: "add", options: [AS] }] };

  test("takes an alias in the spec's name grammar", () => {
    expect(parse(["add", "x", "--as", "acme-2"], ADD).own).toMatchObject({ as: "acme-2" });
  });

  test("refuses any other alias as a usage error", () => {
    for (const alias of ["", "../evil", "Evil Name", "a/b", "x-", "a".repeat(65)]) {
      const error = refusal(["add", "x", "--as", alias], ADD);
      expect(error.code, alias).toBe(ErrorCode.Usage);
      expect(error.message, alias).toMatch(/^--as takes a name such as acme, not /);
    }
    expect(refusal(["add", "x", "--as", "a\u202Eb"], ADD).message).toContain('"a\\u202Eb"');
  });
});

describe("parse, for an option's values", () => {
  const LOGS: Accepts = {
    name: "logs",
    options: [
      { flag: "--level", value: "<level>", choices: ["info", "warn"], describe: "" },
      { flag: "--tail", value: "<count>", integer: { min: 1, max: 9 }, describe: "" },
    ],
  };

  test("hands over a whole number as a number, and a choice as written", () => {
    expect(parse(["--tail", "3", "--level", "warn"], LOGS).own).toMatchObject({
      tail: 3,
      level: "warn",
    });
  });

  test("reads a choice in any case, and hands over the choice as declared", () => {
    expect(parse(["--level", " Warn "], LOGS).own).toMatchObject({ level: "warn" });
  });

  test.each([
    [["--level", "loud"], '--level takes info or warn, not "loud".'],
    [["--tail", "0"], '--tail takes a whole number from 1 to 9, not "0".'],
    [["--tail", "2.5"], '--tail takes a whole number from 1 to 9, not "2.5".'],
  ])("refuses %j as a usage error that says what it takes", (argv, message) => {
    const error = refusal(argv, LOGS);
    expect(error.message).toBe(message);
    expect(error.code).toBe(ErrorCode.Usage);
  });
});

describe("needsInput", () => {
  test("names the command and what it is missing, as a usage error", () => {
    const error = needsInput("job show", "a job name", "Name the job.");
    expect(error.message).toBe("`aireg job show` needs a job name.");
    expect(error.code).toBe(ErrorCode.Usage);
    expect(error.hint).toBe("Name the job.");
  });
});
