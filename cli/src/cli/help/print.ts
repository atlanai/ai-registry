import { list, quoted } from "#adapter/text.ts";
import { type ActionSpec, type CommandSpec, GROUPS } from "#cli/commands/command.ts";
import { allCommands, lookup, warnHidden } from "#cli/commands/index.ts";
import { GLOBAL_OPTIONS } from "#cli/options/flags.ts";
import { closest, didYouMean, unknownAction } from "#cli/options/suggest.ts";
import { callingAgent } from "#cli/prompt/caller.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import type { Example, OptionSpec } from "#core/host/extend.ts";
import { NAME } from "#core/product.ts";
import type { Printer } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import { actionNode, commandNode, docsUrl, ISSUES_URL, ROOT_SUMMARY, ROOT_USAGE } from "./map.ts";

const EXAMPLES: readonly Example[] = [
  {
    command: "aireg registry add github.com/acme/ai-registry -g",
    what: "name a registry once, for every project",
  },
  { command: "aireg add -g acme/engineering", what: "a namespace, for you in every project" },
  {
    command: "aireg add acme/engineering/pr-review@1.2.0",
    what: "one artifact, pinned in this project",
  },
  { command: "aireg show acme/engineering/pr-review", what: "read one without installing it" },
  { command: "aireg status --json", what: "check for changes, as JSON" },
  { command: "aireg install --frozen", what: "fail if the lockfile or manifest would change" },
  { command: "aireg daemon status", what: "check background sync" },
];

/** Named in a command's help; --help, --version and --map run instead of the command. */
const INLINE_GLOBALS = GLOBAL_OPTIONS.filter(
  (option) => !["--help", "--version", "--map"].includes(option.flag),
)
  .map((option) => option.short ?? option.flag)
  .join(", ");

export async function unknownCommand(name: string, hint: string): Promise<AiregError> {
  const commands = await allCommands();
  const names = commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const near = spacedOut(name, commands) ?? closest(name, names);
  return new AiregError(`Unknown command ${quoted(name)}.`, {
    code: ErrorCode.Usage,
    hint: didYouMean(near === undefined ? undefined : `aireg ${near}`, hint),
  });
}

/** A hyphenated word such as `self-update` read as a command and one of its actions. */
function spacedOut(name: string, commands: readonly CommandSpec[]): string | undefined {
  const at = name.indexOf("-");
  if (at === -1) return undefined;
  const [head, rest] = [name.slice(0, at), name.slice(at + 1)];
  const command = commands.find((c) => c.name === head || c.aliases?.includes(head) === true);
  const action = (command?.actions ?? []).find(
    (a) => a.name === rest || a.aliases?.includes(rest) === true,
  );
  return command === undefined || action === undefined
    ? undefined
    : `${command.name} ${action.name}`;
}

/** `strict` refuses an unknown action, as only `aireg help` names one for sure. */
export async function printHelp(
  printer: Printer,
  words: readonly string[],
  strict: boolean,
): Promise<ExitCode> {
  const [name, typed] = words[0] === "help" ? words.slice(1) : words;
  if (name === undefined) {
    await warnHidden(printer);
    if (printer.format === "json") {
      printer.json({
        ok: true,
        data: { commands: (await allCommands()).map((c) => c.name) },
      });
    } else {
      await renderHelp(printer);
    }
    return ExitCode.Ok;
  }
  const command = await lookup(name);
  if (command === undefined) {
    throw await unknownCommand(name, `Run \`aireg ${strict ? "help" : "--help"}\` for the list.`);
  }
  const action =
    typed === undefined
      ? undefined
      : command.actions?.find((a) => a.name === typed || a.aliases?.includes(typed) === true);
  if (strict && typed !== undefined && action === undefined) {
    const names = (command.actions ?? []).map((a) => a.name);
    throw unknownAction(
      command.name,
      typed,
      names,
      names.length === 0
        ? `\`aireg ${command.name}\` has no actions.`
        : `Use ${list(names, "or")}.`,
    );
  }
  if (printer.format === "json") {
    printer.json({
      ok: true,
      data: action === undefined ? commandNode(command) : actionNode(command, action),
    });
  } else {
    renderCommand(printer, command, action);
  }
  return ExitCode.Ok;
}

async function renderHelp(printer: Printer): Promise<void> {
  writeIntro(printer, ROOT_USAGE);

  printer.info();
  printer.info(printer.style.bold("Examples:"));
  writeExamples(printer, EXAMPLES);

  writeGroups(printer, await allCommands(), true);

  printer.info();
  printer.info(printer.style.bold("Options:"));
  for (const line of formatOptions(GLOBAL_OPTIONS)) printer.info(line);

  printer.info();
  printer.info(printer.style.bold("Questions:"));
  printer.info("  On a terminal, commands that change things ask before they do.");
  printer.info("  Every question has an option that answers it, and the option wins.");
  printer.info("  Nothing is asked with --yes or --json, without a terminal, in CI,");
  printer.info("  or inside a coding agent.");

  printer.info();
  printer.info(printer.style.bold("Exit codes:"));
  printer.info("  0 success   1 error   2 usage error   3 changes found   4 sign-in needed");

  printer.info();
  printer.info(printer.style.bold("Learn more:"));
  printer.info("  Run `aireg help <command>` for a command's options and examples.");
  printer.info(`  Docs:   ${docsUrl()}`);
  printer.info(`  Issues: ${ISSUES_URL}`);

  const agent = callingAgent();
  if (agent !== undefined) {
    printer.info();
    printer.info(printer.style.bold("Agent guidance:"));
    printer.info(
      "  aireg --map json   The whole command tree, with each command's options, in one call",
    );
    printer.info("  Machine-readable output and exit codes are documented above.");
  }
}

function writeIntro(printer: Printer, usage: readonly string[]): void {
  printer.info(`${printer.style.bold(NAME)} ${printer.style.dim(VERSION)}`);
  printer.info(ROOT_SUMMARY);
  printer.info();
  writeUsage(printer, usage);
}

function writeUsage(printer: Printer, usage: readonly string[]): void {
  const [first, ...rest] = usage;
  printer.info(`${printer.style.bold("Usage:")} ${first}`);
  for (const line of rest) printer.info(`       ${line}`);
}

function writeExamples(printer: Printer, examples: readonly Example[]): void {
  const width = Math.max(...examples.map((example) => example.command.length));
  for (const { command, what } of examples) {
    printer.info(
      `  ${printer.style.dim("$")} ${command.padEnd(width)}  ${printer.style.dim(what)}`,
    );
  }
}

function writeGroups(printer: Printer, commands: readonly CommandSpec[], actions: boolean): void {
  const width = Math.max(...commands.map((c) => c.name.length));
  for (const group of GROUPS) {
    const inGroup = commands.filter((c) => c.group === group);
    if (inGroup.length === 0) continue;
    printer.info();
    printer.info(printer.style.bold(`${group}:`));
    for (const command of inGroup) {
      printer.info(`  ${command.name.padEnd(width)}  ${command.summary}`);
      if (actions && command.actions !== undefined) {
        const names = (command.actions ?? []).map((action) => action.name).join("  ");
        printer.info(`  ${"".padEnd(width)}  ${printer.style.dim(names)}`);
      }
    }
  }
}

function formatOptions(options: readonly OptionSpec[]): string[] {
  const left = options.map((option) => {
    const flag = option.value === undefined ? option.flag : `${option.flag} ${option.value}`;
    return option.short === undefined ? `    ${flag}` : `${option.short}, ${flag}`;
  });
  const width = Math.max(...left.map((text) => text.length));
  return options.map((option, index) => `  ${left[index]?.padEnd(width)}  ${option.describe}`);
}

function renderCommand(printer: Printer, command: CommandSpec, action: ActionSpec | undefined) {
  const bold = (text: string) => printer.style.bold(text);
  const path = action === undefined ? command.name : `${command.name} ${action.name}`;
  const of = action ?? command;
  const options = of.options ?? [];

  if (of.summary !== undefined) {
    printer.info(of.summary);
    printer.info();
  }
  writeUsage(printer, of.usage ?? [`aireg ${path}${options.length > 0 ? " [options]" : ""}`]);
  if (of.aliases !== undefined && of.aliases.length > 0) {
    const prefix = action === undefined ? "aireg" : `aireg ${command.name}`;
    printer.info(
      `${bold("Aliases:")} ${of.aliases.map((alias) => `${prefix} ${alias}`).join(", ")}`,
    );
  }
  const actions = action === undefined ? (command.actions ?? []) : [];
  if (actions.length > 0) {
    const width = Math.max(...actions.map((a) => a.name.length));
    printer.info();
    printer.info(bold("Actions:"));
    for (const a of actions) {
      const alias = a.aliases === undefined ? "" : ` (alias: ${a.aliases.join(", ")})`;
      printer.info(`  ${a.name.padEnd(width)}  ${a.summary ?? ""}${alias}`.trimEnd());
    }
  }
  if (options.length > 0) {
    printer.info();
    printer.info(bold("Options:"));
    for (const line of formatOptions(options)) printer.info(line);
  }
  if (of.examples !== undefined && of.examples.length > 0) {
    printer.info();
    printer.info(bold("Examples:"));
    writeExamples(printer, of.examples);
  }
  printer.info();
  printer.info(bold("Learn more:"));
  if (actions.some((a) => (a.options ?? []).length > 0)) {
    printer.info(`  Run \`aireg ${command.name} <action> --help\` for an action's options.`);
  }
  printer.info(`  Run \`aireg --help\` for the global options (${INLINE_GLOBALS}).`);
  printer.info(`  Docs: ${docsUrl(command.docs)}`);
}

/** What bare `aireg` prints, the same for a person, a pipe or a coding agent. */
export async function printShortHelp(printer: Printer): Promise<void> {
  await warnHidden(printer);
  writeIntro(printer, ROOT_USAGE.slice(0, 1));
  writeGroups(printer, await allCommands(), false);
  printer.info();
  printer.info(
    `Run \`aireg --help\` for examples, options and exit codes, or \`aireg help <command>\` for one.`,
  );
}
