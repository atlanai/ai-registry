import { list } from "#adapter/text.ts";
import type { Accepts } from "#cli/options/parse.ts";
import { unknownAction } from "#cli/options/suggest.ts";
import type { ExitCode } from "#core/errors.ts";
import type { Example, HostCommandContext, OptionSpec } from "#core/host/extend.ts";

export type CommandContext = HostCommandContext & {
  /** Set by a command that reports a state rather than a failure. */
  exit?: ExitCode;
};

type CommandRun = (context: CommandContext) => Promise<void>;

/** The order `--help` prints, which is the order a new user meets the tool in. */
export const GROUPS = ["Set up", "Install", "Check", "Share", "Automate", "Maintain"] as const;

export type Group = (typeof GROUPS)[number];

/** One verb of a command that has several: `aireg registry add`. */
export interface ActionSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** Absent only on an adapter's action, which declares just its name. */
  readonly summary?: string;
  readonly usage?: readonly string[];
  readonly examples?: readonly Example[];
  /** Everything the action takes; nothing is inherited from the command. */
  readonly options?: readonly OptionSpec[];
  /** The most words it takes after its name; absent takes any number. */
  readonly maxArguments?: number;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  /** Earlier names it still answers to, which help never lists. */
  formerly?: string[];
  summary: string;
  group: Group;
  usage: readonly string[];
  examples?: readonly Example[];
  /** A page under docs/reference/ without `.md`, or a URL for an adapter's command. */
  docs?: string;
  /** What the command takes when no action is named. */
  options?: readonly OptionSpec[];
  /** The most words it takes; absent takes any number. */
  readonly maxArguments?: number;
  actions?: readonly ActionSpec[];
}

export interface Command extends CommandSpec {
  load: () => Promise<{ run: CommandRun }>;
}

/** An action that parses its own argv, as `sync resolve` and `job runs` do. */
export function actionOf(spec: CommandSpec, name: string): Accepts {
  const action = spec.actions?.find((a) => a.name === name);
  return {
    name: `${spec.name} ${name}`,
    options: action?.options ?? [],
    ...(action?.maxArguments === undefined ? {} : { maxArguments: action.maxArguments }),
  };
}

/** Each action's handler under the name the spec gives it, so help and dispatch agree. */
export type ActionHandlers = Readonly<Record<string, () => Promise<void>>>;

/**
 * Runs the handler for `action`, which parsing has already resolved from an alias,
 * or refuses it with the spec's own list. `more` follows that list in the hint.
 */
export function runAction(
  spec: CommandSpec,
  action: string,
  handlers: ActionHandlers,
  more?: string,
): Promise<void> {
  const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
  if (handler !== undefined) return handler();
  const names = (spec.actions ?? []).map((a) => a.name);
  const hint = `Use ${list(names, "or")}.${more === undefined ? "" : ` ${more}`}`;
  throw unknownAction(spec.name, action, names, hint);
}
