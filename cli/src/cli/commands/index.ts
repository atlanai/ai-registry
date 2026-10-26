import { list, quoted } from "#adapter/text.ts";
import type { Accepts } from "#cli/options.ts";
import { unknownAction } from "#cli/suggest.ts";
import type { ExitCode } from "#core/errors.ts";
import type {
  CommandContribution,
  Example,
  HostCommandContext,
  OptionSpec,
} from "#core/host/extend.ts";
import { contributedCommands } from "#core/host/load.ts";
import type { Printer } from "#core/output.ts";

import { COMMANDS, NAMESPACE } from "./table.ts";
export type CommandContext = HostCommandContext & {
  /** Set by a command that reports a state rather than a failure. */
  exit?: ExitCode;
};

type CommandRun = (context: CommandContext) => Promise<void>;

/**
 * The order here is the order `--help` prints, and it is the order a new user
 * meets the tool in: set something up, install into it, check it, share it.
 */
export const GROUPS = ["Set up", "Install", "Check", "Share", "Automate", "Maintain"] as const;

type Group = (typeof GROUPS)[number];

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
  /** Loaded only when the command runs. */
  load: () => Promise<{ run: CommandRun }>;
}

export function builtin(name: string): CommandSpec {
  const spec = COMMANDS.find((c) => c.name === name);
  if (spec === undefined) throw new Error(`No built-in command named ${name}`);
  return spec;
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

function lookupBuiltin(name: string): CommandSpec | undefined {
  return COMMANDS.find(
    (c) => c.name === name || c.aliases?.includes(name) === true || c.formerly?.includes(name),
  );
}

function asGroup(group: string): Group {
  return (GROUPS as readonly string[]).includes(group) ? (group as Group) : "Maintain";
}

function fromContribution(command: CommandContribution): CommandSpec {
  return {
    name: command.name,
    ...(command.aliases === undefined ? {} : { aliases: [...command.aliases] }),
    summary: command.summary,
    group: asGroup(command.group),
    usage: command.usage ?? [
      `aireg ${command.name}${command.actions === undefined ? "" : " <action>"} [options]`,
    ],
    ...(command.examples === undefined ? {} : { examples: command.examples }),
    ...(command.docs === undefined ? {} : { docs: command.docs }),
    ...(command.options === undefined ? {} : { options: command.options }),
    ...(command.actions === undefined
      ? {}
      : { actions: command.actions.map((name) => ({ name })) }),
    load: command.load,
  };
}

/** Names aireg's own commands answer to, so a kind or an adapter's command cannot have them. */
export const RESERVED: ReadonlySet<string> = new Set([
  "help",
  ...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? []), ...(c.formerly ?? [])]),
]);

/** A kind or an adapter's command that a command with the same name hides. */
export interface Hidden {
  readonly name: string;
  readonly message: string;
  readonly hint: string;
}

const PRECEDENCE = "aireg's own commands come first.";

export function hiddenKind(name: string): Hidden {
  return {
    name,
    message: `The kind ${quoted(name)} has the same name as a command, so \`aireg ${name}\` runs the command.`,
    hint: `Rename the kind in registry.json, since ${PRECEDENCE}`,
  };
}

/** Built-ins win over adapters' commands, and both over kinds; `hidden` is what lost. */
async function table(cwd: string): Promise<{ commands: CommandSpec[]; hidden: Hidden[] }> {
  const commands = [...COMMANDS];
  const hidden: Hidden[] = [];
  for (const command of (await contributedCommands()).map(fromContribution)) {
    if (!RESERVED.has(command.name)) {
      commands.push(command);
      continue;
    }
    hidden.push({
      name: command.name,
      message: `An adapter's command ${quoted(command.name)} has the same name as a built-in command, so \`aireg ${command.name}\` runs the built-in one.`,
      hint: `Rename the command in its adapter, since ${PRECEDENCE}`,
    });
  }
  const taken = new Set([...RESERVED, ...commands.flatMap((c) => [c.name, ...(c.aliases ?? [])])]);
  for (const kind of await kindCommands(cwd)) {
    if (taken.has(kind.name)) hidden.push(hiddenKind(kind.name));
    else commands.push(kind);
  }
  return { commands, hidden };
}

/** Every command `--help` and `--map` list, with the kinds the registry here holds. */
export async function allCommands(cwd = process.cwd()): Promise<readonly CommandSpec[]> {
  return (await table(cwd)).commands;
}

export async function warnHidden(printer: Printer, name?: string): Promise<void> {
  const hidden = (await table(process.cwd())).hidden.filter(
    (entry) => name === undefined || entry.name === name,
  );
  printHidden(printer, hidden);
}

export function printHidden(printer: Printer, hidden: readonly Hidden[]): void {
  for (const entry of hidden) printer.warning(entry.message);
  for (const hint of new Set(hidden.map((entry) => entry.hint))) printer.hint(hint);
}

export async function lookup(name: string, cwd = process.cwd()): Promise<CommandSpec | undefined> {
  const own = lookupBuiltin(name);
  if (own !== undefined) return own;
  return (await allCommands(cwd)).find(
    (c) => c.name === name || c.aliases?.includes(name) === true,
  );
}

const KIND_NEW: readonly OptionSpec[] = [
  NAMESPACE,
  {
    flag: "--set",
    value: "<key>=<value>",
    multiple: true,
    describe: "A field to fill in, with dots for nested ones (repeatable)",
  },
  {
    flag: "--file",
    value: "<file>",
    describe: "For a kind with more than one layout, the file to create",
  },
  {
    flag: "--from",
    value: "<path>",
    multiple: true,
    describe: "An existing skill folder or agent file to copy in (repeatable)",
  },
  {
    flag: "--name",
    value: "<name>",
    describe: "With --from, a new name for the artifact copied in",
  },
];

/** A kind the registry here holds is a command of its own: `aireg agent new triage`. */
async function kindCommands(cwd: string): Promise<CommandSpec[]> {
  const { findRegistry } = await import("#core/filespec/write/init.ts");
  const { kindsOf } = await import("#core/filespec/write/kinds.ts");
  return Object.entries(await kindsOf(findRegistry(cwd))).map(([name, manifest]) => {
    const a = /^[aeiou]/.test(name) ? "an" : "a";
    const spec: CommandSpec = {
      name,
      summary: `Create ${a} ${name}, or start its next version`,
      group: "Share",
      usage: [`aireg ${name} <action> [options]`],
      examples: [
        {
          command: `aireg ${name} new pr-review --namespace engineering`,
          what: `a new ${name}`,
        },
        { command: `aireg ${name} bump pr-review minor`, what: "start its next minor version" },
      ],
      docs: "kinds",
      actions: [
        {
          name: "new",
          summary: `Create ${a} ${name}`,
          usage: [
            `aireg ${name} new [<name>] [options]`,
            `aireg ${name} new --from <path>... [options]`,
          ],
          options: KIND_NEW,
        },
        {
          name: "bump",
          summary: `Start the next version of ${a} ${name}`,
          usage: [`aireg ${name} bump <name> [patch | minor | major | <version>] [options]`],
          maxArguments: 2,
          options: [NAMESPACE],
        },
      ],
      load: async () => {
        const { runKind } = await import("./kind.ts");
        return { run: (context) => runKind(spec, manifest, context) };
      },
    };
    return spec;
  });
}
