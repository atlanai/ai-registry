import { parseArgs } from "node:util";
import { list, quoted } from "#adapter/text.ts";
import type { CommandSpec } from "#cli/commands/command.ts";
import { lookup } from "#cli/commands/index.ts";
import { mapTakesValue } from "#cli/help/map.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { LEVEL_CHOICES, LogLevelError } from "#core/log/level.ts";
import { COLOR_WHEN, type ColorWhen } from "#core/term/printer.ts";
import { takeGlobals } from "./parse.ts";
import { didYouMean } from "./suggest.ts";

const GLOBAL_FLAGS = new Set([
  "--json",
  "--verbose",
  "--quiet",
  "-q",
  "--no-color",
  "--version",
  "-v",
  "--help",
  "-h",
]);

const GLOBAL_VALUE_FLAGS = new Set(["--color", "--log-level"]);

/**
 * Globals whose value is optional: bare means a default, and a following
 * word is the value only when it is one - see `mapTakesValue`.
 */
const GLOBAL_OPTIONAL_VALUE_FLAGS = new Set(["--map"]);

export const GLOBALS_HINT = "Run `aireg --help` for the global options.";

/**
 * The command is the first bare word that is not a global flag's value, or
 * `aireg --log-level debug add x` resolves the command as `debug`.
 */
export function findCommand(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (consumesNext(arg, argv[i + 1])) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) return i;
  }
  return -1;
}

function consumesNext(arg: string, next: string | undefined): boolean {
  if (GLOBAL_VALUE_FLAGS.has(arg)) return true;
  return GLOBAL_OPTIONAL_VALUE_FLAGS.has(arg) && mapTakesValue(next);
}

/**
 * Before the command, only globals can appear; after it, the command's own
 * options decide which words are values, so `-m "-v"` is not --version.
 */
export function readGlobals(
  argv: readonly string[],
  commandIndex: number,
  spec: CommandSpec | undefined,
): { values: GlobalValues; rest: string[] } {
  const { values: leading } = parseArgs({
    args: commandIndex === -1 ? [...argv] : argv.slice(0, commandIndex),
    strict: false,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      verbose: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      color: { type: "string" },
      "no-color": { type: "boolean" },
      "log-level": { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  const after = takeGlobals(commandIndex === -1 ? [] : argv.slice(commandIndex + 1), spec);
  return { values: { ...leading, ...after.values }, rest: after.argv };
}

const isCommandName = async (name: string) => (await lookup(name)) !== undefined;

export async function misplacedOption(
  argv: readonly string[],
  commandIndex: number,
  isCommand: (name: string) => Promise<boolean> = isCommandName,
): Promise<AiregError | undefined> {
  const end = commandIndex === -1 ? argv.length : commandIndex;
  const misplaced: number[] = [];
  for (let i = 0; i < end; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--" || !arg.startsWith("-")) continue;
    if (isGlobal(arg)) {
      if (!arg.includes("=") && consumesNext(arg, argv[i + 1])) i += 1;
      continue;
    }
    misplaced.push(i);
  }
  const [first] = misplaced;
  if (first === undefined) return undefined;
  // `--for claude add` made `claude` the command, so only a real one gets the fix.
  const name = argv[commandIndex];
  const known = name !== undefined && (await isCommand(name));
  const fixed = [
    ...argv.slice(0, commandIndex).filter((_, i) => !misplaced.includes(i)),
    name,
    ...misplaced.map((i) => argv[i]),
    ...argv.slice(commandIndex + 1),
  ];
  return new AiregError(
    `${(argv[first] as string).split("=")[0]} must come after the command name.`,
    {
      code: ErrorCode.Usage,
      hint: didYouMean(
        known ? `aireg ${fixed.join(" ")}` : undefined,
        `Only these options can come before the command: ${list(globalNames())}.`,
      ),
    },
  );
}

export type GlobalValues = Partial<Record<string, string | boolean>>;

function isGlobal(arg: string): boolean {
  const name = arg.split("=")[0] as string;
  if (GLOBAL_FLAGS.has(arg) || GLOBAL_VALUE_FLAGS.has(name)) return true;
  return GLOBAL_OPTIONAL_VALUE_FLAGS.has(name);
}

function globalNames(): string[] {
  const all = [...GLOBAL_FLAGS, ...GLOBAL_VALUE_FLAGS, ...GLOBAL_OPTIONAL_VALUE_FLAGS];
  return all.filter((flag) => flag.startsWith("--"));
}

/** A bad `--color` is refused earlier, by `misusedGlobal`. */
export function colorWhen(values: GlobalValues): ColorWhen {
  if (values["no-color"] === true) return "never";
  return COLOR_WHEN.find((when) => when === values.color) ?? "auto";
}

export function misusedGlobal(values: GlobalValues): AiregError | undefined {
  if (values.quiet === true && values.verbose === true) return together("--quiet", "--verbose");
  if (values["log-level"] === true) {
    return new AiregError("--log-level needs a value.", {
      code: ErrorCode.Usage,
      hint: `Use ${list(LEVEL_CHOICES, "or")}.`,
    });
  }
  const level = values["log-level"];
  if (
    typeof level === "string" &&
    !LEVEL_CHOICES.some((choice) => choice === level.trim().toLowerCase())
  ) {
    return new LogLevelError(level, "--log-level");
  }
  const { color } = values;
  if (color === undefined) return undefined;
  if (values["no-color"] === true) return together("--color", "--no-color");
  if (COLOR_WHEN.some((when) => when === color)) return undefined;
  const problem =
    typeof color === "string"
      ? `--color takes ${list(COLOR_WHEN, "or")}, not ${quoted(color)}.`
      : "--color needs a value.";
  return new AiregError(problem, { code: ErrorCode.Usage, hint: GLOBALS_HINT });
}

function together(one: string, other: string): AiregError {
  return new AiregError(`${one} and ${other} cannot be used together.`, {
    code: ErrorCode.Usage,
    hint: "Pass one or the other.",
  });
}
