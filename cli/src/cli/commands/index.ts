import { list, quoted } from "#adapter/text.ts";
import { AUTOMATE } from "#cli/commands/table/automate.ts";
import { CHECK } from "#cli/commands/table/check.ts";
import { INSTALL } from "#cli/commands/table/install.ts";
import { kindCommands } from "#cli/commands/table/kinds.ts";
import { MAINTAIN } from "#cli/commands/table/maintain.ts";
import { SET_UP } from "#cli/commands/table/set-up.ts";
import { SHARE } from "#cli/commands/table/share.ts";
import { type CommandSpec, GROUPS, type Group } from "#cli/commands/table/spec.ts";
import type { Accepts } from "#cli/options.ts";
import { unknownAction } from "#cli/suggest.ts";
import type { CommandContribution } from "#core/host/extend.ts";
import { contributedCommands } from "#core/host/load.ts";
import type { Printer } from "#core/output.ts";

export type { ActionSpec, CommandContext, CommandSpec } from "#cli/commands/table/spec.ts";
export { GROUPS } from "#cli/commands/table/spec.ts";

/** Every built-in command, in the order `--help` lists them; each group's entries are in `table/`. */
export const COMMANDS: readonly CommandSpec[] = [
  ...SET_UP,
  ...INSTALL,
  ...CHECK,
  ...SHARE,
  ...AUTOMATE,
  ...MAINTAIN,
];

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
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name) === true);
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
  ...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
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
