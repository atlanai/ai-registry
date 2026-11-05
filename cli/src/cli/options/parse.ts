import { type ParseArgsConfig, parseArgs } from "node:util";
import { messageOf } from "#adapter/errors.ts";
import { isNamespace } from "#adapter/filespec/names.ts";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import type { Scope } from "#core/store/paths.ts";
import { canonicalIds } from "#core/target/ids.ts";
import { resolveTargets } from "#core/target/table.ts";
import type { CommonOptions } from "#engine/options.ts";
import { AFTER_COMMAND, AS, YES } from "./flags.ts";
import { closest, didYouMean } from "./suggest.ts";

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

/** A required argument or option is missing; `hint` shows the command with it filled in. */
export function needsInput(command: string, what: string, hint: string): AiregError {
  return new AiregError(`\`aireg ${command}\` needs ${what}.`, { code: ErrorCode.Usage, hint });
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
  checkValues(declared, values, accepts.name);

  const scope: Scope | undefined = values.user === true ? "user" : undefined;

  const all = values.all === true;
  return {
    positionals,
    common: {
      scope,
      targets: canonicalFor(split(values.for as string[] | undefined)),
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

type ValueOf<O extends OptionSpec> = O extends { integer: object }
  ? number
  : O extends { choices: readonly (infer C)[] }
    ? C
    : O extends { value: string }
      ? O extends { multiple: true }
        ? string[]
        : string
      : boolean;

/** Keyed by flag without the dashes. */
export type OptionsOf<T extends readonly OptionSpec[]> = {
  [O in T[number] as O["flag"] extends `--${infer Name}` ? Name : never]?: ValueOf<O>;
};

export interface Parsed<T> {
  positionals: string[];
  common: CommonOptions;
  own: T;
}

const helpHint = (path: string) => `Run \`aireg ${path} --help\` for the options it takes.`;

/** Refuses a value outside an option's `choices` or `integer` range, and makes an integer a number. */
function checkValues(
  declared: readonly OptionSpec[],
  values: Record<string, unknown>,
  path: string,
): void {
  for (const option of declared) {
    const key = option.flag.slice(2);
    const value = values[key];
    if (typeof value !== "string") continue;
    if (option.choices !== undefined) {
      // `--kind Skill` names the same choice as `--kind skill`; the command sees the choice.
      const chosen = option.choices.find((choice) => choice === value.trim().toLowerCase());
      if (chosen === undefined) {
        throw valueError(option, `${list(option.choices, "or")}`, value, path);
      }
      values[key] = chosen;
    }
    if (option.integer !== undefined) values[key] = integerOf(option, option.integer, value, path);
  }
}

function integerOf(
  option: OptionSpec,
  range: { min?: number; max?: number },
  value: string,
  path: string,
): number {
  const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const { min, max } = range;
  const inRange =
    Number.isSafeInteger(number) &&
    (min === undefined || number >= min) &&
    (max === undefined || number <= max);
  if (inRange) return number;
  const bounds =
    min !== undefined && max !== undefined
      ? ` from ${min} to ${max}`
      : min !== undefined
        ? ` of at least ${min}`
        : max !== undefined
          ? ` of at most ${max}`
          : "";
  throw valueError(option, `a whole number${bounds}`, value, path);
}

function valueError(option: OptionSpec, takes: string, value: string, path: string): AiregError {
  return new AiregError(`${option.flag} takes ${takes}, not ${quoted(value)}.`, {
    code: ErrorCode.Usage,
    hint: helpHint(path),
  });
}

/** Every option a command takes, across its actions, since the parser sees them all at once. */
function declaredBy(accepts: Accepts): OptionSpec[] {
  return [
    YES,
    ...(accepts.options ?? []),
    ...(accepts.actions ?? []).flatMap((action) => action.options ?? []),
  ];
}

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
  const message = messageOf(cause);
  return new AiregError(message.split("\n")[0] as string, {
    code: ErrorCode.Usage,
    hint,
  });
}

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

/** An alias is the first segment of every address, so it takes the spec's name grammar. */
function refuseAlias(alias: string): void {
  if (isNamespace(alias)) return;
  throw new AiregError(`--as takes a name such as acme, not ${quoted(alias)}.`, {
    code: ErrorCode.Usage,
    hint: "Use 1 to 64 lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
  });
}

/** `--for` takes a target's aliases too; everything after it sees the canonical id. */
function canonicalFor(ids: string[] | undefined): string[] | undefined {
  return ids === undefined ? undefined : canonicalIds(resolveTargets(process.env), ids);
}

/** `--for claude-code,cursor` and `--for claude-code --for cursor` both mean the same thing. */
function split(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const flat = values
    .flatMap((value) => value.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return flat.length === 0 ? undefined : flat;
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
