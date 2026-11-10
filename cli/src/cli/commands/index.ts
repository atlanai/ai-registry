import { quoted } from "#adapter/text.ts";
import { NAMESPACE } from "#cli/options/flags.ts";
import type { CommandContribution, OptionSpec } from "#core/host/extend.ts";
import { contributedCommands } from "#core/host/load.ts";
import type { Printer } from "#core/term/printer.ts";
import {
  BUILTIN_SPECS,
  type Hidden,
  hiddenKind,
  PRECEDENCE,
  printHidden,
  RESERVED,
} from "./builtins.ts";
import { type Command, GROUPS, type Group } from "./command.ts";

/** Loaded only when that command runs. */
const LOADERS: Readonly<Record<string, Command["load"]>> = {
  init: () => import("./init.ts"),
  registry: () => import("./registry.ts"),
  auth: () => import("./auth.ts"),
  search: () => import("./search.ts"),
  add: () => import("./add.ts"),
  remove: () => import("./remove.ts"),
  install: () => import("./install.ts"),
  update: () => import("./update.ts"),
  show: () => import("./show.ts"),
  console: () => import("./console.ts"),
  ui: () => import("./ui.ts"),
  status: () => import("./status.ts"),
  list: () => import("./list.ts"),
  outdated: () => import("./outdated.ts"),
  targets: () => import("./targets.ts"),
  sync: () => import("./sync.ts"),
  publish: () => import("./publish.ts"),
  watch: () => import("./watch.ts"),
  job: () => import("./job.ts"),
  daemon: () => import("./daemon.ts"),
  config: () => import("./config.ts"),
  doctor: () => import("./doctor.ts"),
  unlock: () => import("./unlock.ts"),
  adapter: () => import("./adapter.ts"),
  logs: () => import("./logs.ts"),
  self: () => import("./self.ts"),
};

/** In the order `--help` lists each group. */
export const COMMANDS: readonly Command[] = BUILTIN_SPECS.map((spec) => {
  const load = LOADERS[spec.name];
  if (load === undefined) throw new Error(`No module for the built-in command ${spec.name}`);
  return { ...spec, load };
});

/** A built-in command by its name; throws when no built-in has it. */
export function builtin(name: string): Command {
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) throw new Error(`No built-in command named ${name}`);
  return command;
}

export async function allCommands(cwd = process.cwd()): Promise<readonly Command[]> {
  return (await table(cwd)).commands;
}

/** Built-ins win over adapters' commands, and both over kinds; `hidden` is what lost. */
async function table(cwd: string): Promise<{ commands: Command[]; hidden: Hidden[] }> {
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

function fromContribution(command: CommandContribution): Command {
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

function asGroup(group: string): Group {
  return (GROUPS as readonly string[]).includes(group) ? (group as Group) : "Maintain";
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
async function kindCommands(cwd: string): Promise<Command[]> {
  const { findRegistry } = await import("#core/filespec/init.ts");
  const { kindsOf } = await import("#core/filespec/kind-manifests.ts");
  return Object.entries(await kindsOf(findRegistry(cwd))).map(([name, manifest]) => {
    const a = /^[aeiou]/.test(name) ? "an" : "a";
    const spec: Command = {
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

export async function warnHidden(printer: Printer, name?: string): Promise<void> {
  const hidden = (await table(process.cwd())).hidden.filter(
    (entry) => name === undefined || entry.name === name,
  );
  printHidden(printer, hidden);
}

export async function lookup(name: string, cwd = process.cwd()): Promise<Command | undefined> {
  const own = lookupBuiltin(name);
  if (own !== undefined) return own;
  return (await allCommands(cwd)).find(
    (c) => c.name === name || c.aliases?.includes(name) === true,
  );
}

function lookupBuiltin(name: string): Command | undefined {
  return COMMANDS.find(
    (c) => c.name === name || c.aliases?.includes(name) === true || c.formerly?.includes(name),
  );
}
