import { type ParseArgsConfig, parseArgs } from "node:util";
import { isNamespace } from "#adapter/filespec/names.ts";
import { LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import { COLOR_WHEN } from "#core/output.ts";
import type { Scope } from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";
import { closest, didYouMean } from "./suggest.ts";

/** Scope follows the package-manager convention: this project, unless `-g`. */
export const USER: OptionSpec = {
  flag: "--user",
  short: "-g",
  describe: "Act on your user scope instead of this project",
};
export const FOR: OptionSpec = {
  flag: "--for",
  value: "<harness>",
  multiple: true,
  describe: "The harnesses to install into, comma-separated, or * for all of them",
};
export const SELECT: OptionSpec = {
  flag: "--select",
  short: "-s",
  value: "<name>",
  multiple: true,
  describe: "The artifacts or namespaces to act on",
};
const YES: OptionSpec = {
  flag: "--yes",
  short: "-y",
  describe: "Take the defaults without asking",
};
export const ALL: OptionSpec = { flag: "--all", describe: "Act on everything, without asking" };
export const COPY: OptionSpec = {
  flag: "--copy",
  describe: "Copy into each harness folder instead of linking",
};
export const DRY_RUN: OptionSpec = {
  flag: "--dry-run",
  describe: "Print what would change without changing it",
};
export const FROZEN: OptionSpec = {
  flag: "--frozen",
  describe: "Fail with exit status 3 if the lockfile or the manifest would change",
};
export const FORCE: OptionSpec = {
  flag: "--force",
  describe: "Overwrite artifacts edited after they were installed",
};
export const AS: OptionSpec = {
  flag: "--as",
  value: "<name>",
  describe: "The name to save the registry under",
};

export const ADAPTER: OptionSpec = {
  flag: "--adapter",
  value: "<id>",
  describe: "The adapter that reads the registry, when aireg cannot tell",
};
const CONFIG: OptionSpec = {
  flag: "--config",
  value: "<key>=<value>",
  multiple: true,
  describe: "A setting for that adapter (repeatable)",
};
const REF: OptionSpec = {
  flag: "--ref",
  value: "<ref>",
  describe: "For a git registry, the branch, tag or commit to read",
};
const PATH: OptionSpec = {
  flag: "--path",
  value: "<folder>",
  describe: "For a git registry, the folder that holds it",
};

const LAYOUT: OptionSpec = {
  flag: "--layout",
  value: "<layout>",
  describe: `How to read the source, instead of telling from what it holds: ${list([...LAYOUT_IDS], "or")}`,
};

/** Taken by every command that reads a registry from its address. */
export const SOURCE: readonly OptionSpec[] = [REF, PATH, ADAPTER, LAYOUT, CONFIG];

export const MAP_FORMATS = ["tree", "compact", "json"] as const;
export type MapFormat = (typeof MAP_FORMATS)[number];

/** Read before the command by main.ts, except --yes, which every command's parse accepts. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { flag: "--json", describe: "Machine-readable output" },
  { flag: "--verbose", describe: "Print each step" },
  { flag: "--quiet", short: "-q", describe: "Print only results, warnings and errors" },
  { flag: "--color", value: "<when>", describe: `Color the output: ${list(COLOR_WHEN, "or")}` },
  { flag: "--no-color", describe: "The same as --color never" },
  {
    flag: "--log-level",
    value: "<level>",
    describe: "The diagnostic log level, on stderr and in the log file",
  },
  {
    flag: "--map",
    value: "[format]",
    describe: `Print the full command tree and exit: ${list(MAP_FORMATS, "or")}`,
  },
  YES,
  { flag: "--help", short: "-h", describe: "Print help, or after a command, its help" },
  { flag: "--version", short: "-v", describe: "Print the version and exit" },
];

/** --version is read only before the command, and --map runs instead of any command. */
const AFTER_COMMAND = GLOBAL_OPTIONS.filter(
  (option) => !["--yes", "--version", "--map"].includes(option.flag),
);

/** What `parse` checks argv against: a command, or an action that parses on its own. */
export interface Accepts {
  /** As typed after `aireg`, for the hint: `list`, `sync resolve`. */
  readonly name: string;
  readonly options?: readonly OptionSpec[];
  /** The most words it takes; absent takes any number. */
  readonly maxArguments?: number;
  readonly actions?: readonly AcceptedAction[];
}

interface AcceptedAction {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly options?: readonly OptionSpec[];
  /** The most words it takes after its name; absent takes any number. */
  readonly maxArguments?: number;
}

type ParseOptions = NonNullable<ParseArgsConfig["options"]>;
type Token = NonNullable<ReturnType<typeof parseArgs>["tokens"]>[number];
type OptionToken = Extract<Token, { kind: "option" }>;

function toParseArgs(options: readonly OptionSpec[]): ParseOptions {
  const config: ParseOptions = {};
  for (const option of options) {
    config[option.flag.slice(2)] = {
      type: option.value === undefined ? "boolean" : "string",
      ...(option.short === undefined ? {} : { short: option.short.slice(1) }),
      ...(option.multiple === undefined ? {} : { multiple: true }),
    };
  }
  return config;
}

/** `--for claude,cursor` and `--for claude --for cursor` both mean the same thing. */
function split(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const flat = values
    .flatMap((value) => value.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return flat.length === 0 ? undefined : flat;
}

export interface Parsed<T> {
  positionals: string[];
  common: CommonOptions;
  own: T;
}

const helpHint = (path: string) => `Run \`aireg ${path} --help\` for the options it takes.`;

function unknownOption(token: OptionToken, options: ParseOptions, hint: string): AiregError {
  // After a command, -v reads as --verbose to many tools; aireg's version goes before it.
  if (token.name === "v" || token.name === "version") {
    return new AiregError(`Unknown option ${quoted(token.rawName)}.`, {
      code: ErrorCode.Usage,
      hint: didYouMean("--verbose", "For the version, run `aireg --version`."),
    });
  }
  const near = closest(
    token.rawName,
    Object.keys(options).map((name) => `--${name}`),
  );
  return new AiregError(`Unknown option ${quoted(token.rawName)}.`, {
    code: ErrorCode.Usage,
    hint: didYouMean(near, hint),
  });
}

/** Node's text names its own API and leaves a quote open, so the bad token is named again plainly. */
function optionError(
  argv: string[],
  options: ParseOptions,
  cause: unknown,
  hint: string,
): AiregError {
  const { tokens } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    if (option === undefined) return unknownOption(token, options, hint);
    // Node refuses a separate value that starts with "-"; only the `=` form says it is one.
    if (option.type === "string" && token.inlineValue === false && token.value?.startsWith("-")) {
      return new AiregError(
        `${token.rawName} needs a value, and ${quoted(token.value)} reads as an option.`,
        {
          code: ErrorCode.Usage,
          hint: `If it is the value, write \`--${token.name}=${quoted(token.value)}\`.`,
        },
      );
    }
    const problem =
      option.type === "string" && token.value === undefined
        ? `${token.rawName} needs a value.`
        : option.type === "boolean" && token.inlineValue === true
          ? `${token.rawName} takes no value.`
          : undefined;
    if (problem !== undefined) return new AiregError(problem, { code: ErrorCode.Usage, hint });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AiregError(message.split("\n")[0] as string, {
    code: ErrorCode.Usage,
    hint,
  });
}

/** A stray word is usually meant for another command; dropping it hides that. */
export function noArguments(
  positionals: readonly string[],
  command: string,
  hint = `Run \`aireg ${command} --help\` for its usage.`,
): void {
  if (positionals.length === 0) return;
  throw new AiregError(
    `\`aireg ${command}\` takes no argument, not ${quoted(positionals[0] as string)}.`,
    { code: ErrorCode.Usage, hint },
  );
}

function refuseExtra(words: readonly string[], command: string, most: number | undefined): void {
  if (most === undefined || words.length <= most) return;
  if (most === 0) {
    noArguments(words, command);
    return;
  }
  const takes = most === 1 ? "one argument" : `${most} arguments`;
  throw new AiregError(
    `\`aireg ${command}\` takes at most ${takes}, not also ${quoted(words[most] as string)}.`,
    { code: ErrorCode.Usage, hint: `Run \`aireg ${command} --help\` for its usage.` },
  );
}

/** An alias is the first segment of every address, so it takes the spec's name grammar. */
function refuseAlias(alias: string): void {
  if (isNamespace(alias)) return;
  throw new AiregError(`--as takes a name such as acme, not ${quoted(alias)}.`, {
    code: ErrorCode.Usage,
    hint: "Use 1 to 64 lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
  });
}

function actionNamed(accepts: Accepts, word: string | undefined): AcceptedAction | undefined {
  if (word === undefined) return undefined;
  return accepts.actions?.find(
    (candidate) => candidate.name === word || candidate.aliases?.includes(word) === true,
  );
}

/** The parser takes every action's options at once; each action takes only its own. */
function refuseUntaken(
  accepts: Accepts,
  action: AcceptedAction | undefined,
  tokens: readonly Token[],
  extra: ParseOptions,
): void {
  const taken = new Set(
    [YES, ...((action === undefined ? accepts.options : action.options) ?? [])].map((option) =>
      option.flag.slice(2),
    ),
  );
  const path = action === undefined ? accepts.name : `${accepts.name} ${action.name}`;
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (taken.has(token.name) || Object.hasOwn(extra, token.name)) continue;
    throw new AiregError(`\`aireg ${path}\` does not take ${quoted(token.rawName)}.`, {
      code: ErrorCode.Usage,
      hint: helpHint(path),
    });
  }
}

/** Every option a command takes, across its actions, since the parser sees them all at once. */
function declaredBy(accepts: Accepts): OptionSpec[] {
  return [
    YES,
    ...(accepts.options ?? []),
    ...(accepts.actions ?? []).flatMap((action) => action.options ?? []),
  ];
}

export function parse<T extends Record<string, unknown>>(
  argv: string[],
  accepts: Accepts,
  extra: ParseOptions = {},
): Parsed<T> {
  const declared = declaredBy(accepts);
  const options = { ...toParseArgs(declared), ...extra };
  let values: Record<string, unknown>;
  let positionals: string[];
  let tokens: Token[];
  try {
    ({ values, positionals, tokens } = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    }));
  } catch (cause) {
    throw optionError(argv, options, cause, helpHint(accepts.name));
  }
  if (accepts.actions === undefined) {
    refuseExtra(positionals, accepts.name, accepts.maxArguments);
  } else {
    const action = actionNamed(accepts, positionals[0]);
    refuseUntaken(accepts, action, tokens, extra);
    if (action !== undefined) {
      // Aliases are declared once in the table, so commands only ever see the name.
      positionals[0] = action.name;
      refuseExtra(positionals.slice(1), `${accepts.name} ${action.name}`, action.maxArguments);
    } else {
      refuseExtra(positionals, accepts.name, accepts.maxArguments);
    }
  }
  if (typeof values.as === "string" && declared.includes(AS)) refuseAlias(values.as);

  const scope: Scope | undefined = values.user === true ? "user" : undefined;

  const all = values.all === true;
  return {
    positionals,
    common: {
      scope,
      targets: split(values.for as string[] | undefined),
      select: all ? ["*"] : split(values.select as string[] | undefined),
      yes: values.yes === true || all,
      all,
      dryRun: values["dry-run"] === true,
      frozen: values.frozen === true,
      force: values.force === true,
      copy: values.copy === true,
    },
    own: values as T,
  };
}

export interface Globals {
  /** The command's own words, without the global flags. */
  argv: string[];
  values: Record<string, string | boolean>;
}

/**
 * Takes the global flags out of what follows the command. Its own options are
 * read alongside, so the value in `-m "-v"` stays a value instead of a flag.
 */
export function takeGlobals(argv: readonly string[], accepts: Accepts | undefined): Globals {
  const globals = toParseArgs(AFTER_COMMAND);
  const own = accepts === undefined ? {} : toParseArgs(declaredBy(accepts));
  const { tokens } = parseArgs({
    args: [...argv],
    options: { ...own, ...globals },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const values: Record<string, string | boolean> = {};
  const byIndex = new Map<number, OptionToken[]>();
  for (const token of tokens) {
    if (token.kind === "option-terminator") break;
    if (token.kind !== "option") continue;
    byIndex.set(token.index, [...(byIndex.get(token.index) ?? []), token]);
  }
  const rewritten = new Map<number, string | undefined>();
  for (const [index, options] of byIndex) {
    const global = options.filter((token) => Object.hasOwn(globals, token.name));
    if (global.length === 0) continue;
    for (const token of global) {
      values[token.name] = token.value ?? true;
      if (token.value !== undefined && token.inlineValue === false)
        rewritten.set(index + 1, undefined);
    }
    // A cluster such as `-yq` keeps the letters that are the command's own.
    const kept = options.filter((token) => !global.includes(token));
    const last = kept.at(-1);
    rewritten.set(
      index,
      last === undefined
        ? undefined
        : `-${kept.map((token) => token.rawName.slice(1)).join("")}${last.inlineValue === true ? last.value : ""}`,
    );
  }
  const rest = argv.flatMap((arg, index) => {
    if (!rewritten.has(index)) return [arg];
    const kept = rewritten.get(index);
    return kept === undefined ? [] : [kept];
  });
  return { argv: rest, values };
}
