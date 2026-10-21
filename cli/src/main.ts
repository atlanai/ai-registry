import { homedir } from "node:os";
import { list, quoted, sanitizeBlock } from "#adapter/text.ts";
import { stopGit } from "#adapters/git/api.ts";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import {
  colorWhen,
  findCommand,
  GLOBALS_HINT,
  type GlobalValues,
  misplacedOption,
  misusedGlobal,
  readGlobals,
} from "#cli/argv.ts";
import { type CommandContext, type CommandSpec, lookup, warnHidden } from "#cli/commands/index.ts";
import { printHelp, printShortHelp, unknownCommand } from "#cli/help.ts";
import { findMapFormat, runMap } from "#cli/map.ts";
import { reportError } from "#cli/report.ts";
import { closest, didYouMean } from "#cli/suggest.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { releaseLeasesOnInterrupt } from "#core/lease.ts";
import { LogLevelError } from "#core/log/index.ts";
import { type LogBootstrap, openCliLog } from "#core/log/open.ts";
import { Printer } from "#core/output.ts";
import { NODE_REQUIREMENT, nodeTooOld, VERSION, versionInfo } from "#core/version.ts";
import { extensionHost } from "#daemon/extension-host.ts";
import { recycleDaemon } from "#daemon/service.ts";
import { hintUpdate, refreshUpdates, scheduleUpdateCheck, UPDATE_CHECK_FLAG } from "#self/check.ts";
import { applyMinimumUpdate } from "#self/minimum.ts";
import { REMOVE_AFTER_FLAG, removeAfterExit } from "#self/remove-after.ts";

registerBuiltinAdapters();

/**
 * Drops `node:sqlite`'s experimental warning, which a user of this CLI cannot
 * act on, and a color warning that is untrue of aireg. Every other warning stays.
 */
function ignoreNodeWarnings(): void {
  // Node prints warnings from its own listener, so ours has to replace it
  // rather than sit beside it.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    if (/'NO_COLOR' env is ignored/.test(warning.message)) return;
    process.stderr.write(sanitizeBlock(`${warning.name}: ${warning.message}\n`));
  });
}

/**
 * `aireg list | head` closes stdout early. Without this, node raises an
 * unhandled EPIPE and prints a stack trace over the output the user wanted.
 */
function ignoreClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
      process.exit(ExitCode.Ok);
    });
  }
}

/**
 * `--map` runs instead of any command, so it is read from the raw argv rather
 * than the command's own: `findCommand` may have picked a different word.
 */
async function mapIfRequested(printer: Printer, argv: string[]): Promise<ExitCode | undefined> {
  const format = findMapFormat(argv);
  if (format === undefined) return undefined;
  return await runMap(printer, format);
}

async function unknownKind(name: string, action: string): Promise<AiregError> {
  const { findRegistry } = await import("#core/filespec/write/init.ts");
  const { kindsOf } = await import("#core/filespec/write/kinds.ts");
  const root = findRegistry(process.cwd());
  const kinds = Object.keys(await kindsOf(root));
  const near = closest(name, kinds);
  return new AiregError(
    `No kind named ${quoted(name)}${root === undefined ? "" : " in this registry"}.`,
    {
      code: ErrorCode.Usage,
      hint: didYouMean(
        near === undefined ? undefined : `aireg ${near} ${action}`,
        `Use ${list(kinds, "or")}.`,
      ),
    },
  );
}

/** A stray throw skips main's catch, and handling it suppresses Node's exit, so this exits. */
function reportStrayErrors(printer: Printer): void {
  const report = (error: unknown) => process.exit(reportError(printer, error));
  process.once("uncaughtException", report);
  process.once("unhandledRejection", report);
}

/** The installer's last step on the binary it downloaded; a flag, not a command. */
async function setup(printer: Printer, rest: string[]): Promise<ExitCode> {
  const yes = rest.length === 1 && (rest[0] === "--yes" || rest[0] === "-y");
  if (rest.length > 0 && !yes) {
    const extra = rest.find((arg) => arg !== "--yes" && arg !== "-y") ?? (rest[1] as string);
    throw new AiregError(`\`aireg --setup\` takes only --yes, not ${quoted(extra)}.`, {
      code: ErrorCode.Usage,
      hint: "Run `aireg --setup`, or `aireg --setup --yes` to accept every default.",
    });
  }
  const { install } = await import("#cli/onboarding/setup.ts");
  const context = { argv: [], cwd: homedir(), printer, host: extensionHost(VERSION) };
  return (await install(context, yes)) as ExitCode;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<ExitCode> {
  ignoreClosedPipe();
  ignoreNodeWarnings();

  const commandIndex = findCommand(argv);
  const name = commandIndex === -1 ? undefined : (argv[commandIndex] as string);
  // A command that fails to load is reported by dispatch, once the printer exists.
  const spec =
    name === undefined || name === "help" ? undefined : await lookup(name).catch(() => undefined);
  const { values, rest } = readGlobals(argv, commandIndex, spec);

  const printer = new Printer({
    format: values.json === true ? "json" : "text",
    verbose: values.verbose === true,
    quiet: values.quiet === true,
    color: colorWhen(values),
  });
  try {
    return await dispatch(argv, commandIndex, rest, printer, values);
  } catch (error) {
    return reportError(printer, error);
  }
}

async function dispatch(
  argv: string[],
  commandIndex: number,
  rest: string[],
  printer: Printer,
  values: GlobalValues,
): Promise<ExitCode> {
  const tooOld = nodeTooOld();
  if (tooOld !== undefined)
    return reportError(
      printer,
      new AiregError(tooOld, {
        hint: `Install a supported Node.js version (${NODE_REQUIREMENT}).`,
      }),
    );

  const misused = misusedGlobal(values);
  if (misused !== undefined) return reportError(printer, misused);

  if (argv.length === 1 && argv[0] === "--internal-daemon") {
    // A daemon outlives whatever started it, so it must not keep that
    // process's directory: one it cannot read fails every `process.cwd()`.
    process.chdir(homedir());
    const { runDaemon } = await import("#daemon/runtime.ts");
    return (await runDaemon(VERSION)) as ExitCode;
  }
  if (argv.length === 3 && argv[0] === REMOVE_AFTER_FLAG) {
    await removeAfterExit(Number(argv[1]), argv[2] as string).catch(() => undefined);
    return ExitCode.Ok;
  }
  if (argv.length === 1 && argv[0] === UPDATE_CHECK_FLAG) {
    await refreshUpdates(recycleDaemon).catch(() => undefined);
    return ExitCode.Ok;
  }
  // After the daemon branch: the daemon installs its own, which log instead.
  reportStrayErrors(printer);
  // git runs in its own process group, out of reach of the terminal's Ctrl-C.
  releaseLeasesOnInterrupt(stopGit);

  if (argv[0] === "--setup") return await setup(printer, argv.slice(1));

  const name = commandIndex === -1 ? undefined : argv[commandIndex];

  const answered = await answerWithoutCommand(printer, argv, commandIndex, rest, values);
  if (answered !== undefined) return answered;
  if (name === undefined) return ExitCode.Usage;

  const spec: CommandSpec | undefined = await lookup(name);
  const action = rest[0];
  const kindAction = action === "new" || action === "bump";
  if (spec === undefined && kindAction) {
    return reportError(printer, await unknownKind(name, action));
  }
  if (spec === undefined) {
    return reportError(printer, await unknownCommand(name, "Run `aireg --help` for the list."));
  }
  if (kindAction) await warnHidden(printer, name);
  return runCommand(printer, argv, name, spec, rest, values);
}

/** `--version`, `--map`, help, and no command at all: answered before any command loads. */
async function answerWithoutCommand(
  printer: Printer,
  argv: string[],
  commandIndex: number,
  rest: string[],
  values: GlobalValues,
): Promise<ExitCode | undefined> {
  const name = commandIndex === -1 ? undefined : argv[commandIndex];
  if (values.version === true && values.help !== true) {
    if (printer.format === "json") {
      printer.json({ ok: true, data: versionInfo() });
    } else {
      printer.info(VERSION);
    }
    return ExitCode.Ok;
  }

  const mapped = await mapIfRequested(printer, argv);
  if (mapped !== undefined) return mapped;

  if (values.help !== true) {
    const misplaced = await misplacedOption(argv, commandIndex);
    if (misplaced !== undefined) return reportError(printer, misplaced);
  }

  if (name === "help" || values.help === true) {
    const strict = name === "help";
    const words = rest.filter((arg) => !arg.startsWith("-"));
    const asked = strict ? words : name === undefined ? [] : [name, ...words.slice(0, 1)];
    return await printHelp(printer, asked, strict);
  }

  if (name !== undefined) return undefined;
  // No command ran, so --json reports that as the failure the exit status says.
  if (printer.format === "json") {
    return reportError(
      printer,
      new AiregError("No command given.", {
        code: ErrorCode.Usage,
        hint: "Run `aireg --help --json` for the commands, or `aireg --map json` for each one's options.",
      }),
    );
  }
  await printShortHelp(printer);
  return ExitCode.Usage;
}

async function runCommand(
  printer: Printer,
  argv: string[],
  name: string,
  spec: CommandSpec,
  rest: string[],
  values: GlobalValues,
): Promise<ExitCode> {
  let log: LogBootstrap;
  try {
    log = openCliLog(VERSION, values["log-level"] as string | undefined);
  } catch (error) {
    // Reached before the logger exists, so this one is only ever printed.
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof LogLevelError ? ErrorCode.Usage : ErrorCode.Error;
    return reportError(printer, new AiregError(message, { code, hint: GLOBALS_HINT }));
  }
  const command = log.logger.child({ command: name });
  const startedAtMs = Date.now();
  command.info("command starting");
  // Updating aireg from inside its own update or adapter commands would race them.
  const checksUpdates = name !== "self" && name !== "adapter";

  try {
    if (name !== "self") {
      const outcome = await applyMinimumUpdate(printer, argv, recycleDaemon);
      if (outcome.kind === "reexec") return outcome.code as ExitCode;
    }
    const { run } = await spec.load();
    const context: CommandContext = {
      argv: rest,
      cwd: process.cwd(),
      printer,
      host: extensionHost(VERSION),
    };
    await run(context);
    const code = context.exit ?? ExitCode.Ok;
    if (code === ExitCode.Ok && checksUpdates) {
      await hintUpdate(printer).catch(() => undefined);
    }
    command.info("command finished", { code, durationMs: Date.now() - startedAtMs });
    return code;
  } catch (error) {
    // The printer says one line to the human; this keeps the cause.
    command.error("command failed", { error, durationMs: Date.now() - startedAtMs });
    return reportError(printer, error);
  } finally {
    if (checksUpdates) await scheduleUpdateCheck().catch(() => undefined);
    log.close();
  }
}

/**
 * Node's fetch keeps an aborted connection open until its own 10 s connect timeout,
 * so a finished command exits once its output is written instead of waiting on it.
 */
function exitWhenWritten(code: number): void {
  let pending = 2;
  for (const stream of [process.stdout, process.stderr]) {
    // `end`, not an empty write: Bun calls that back before queued output reaches a pipe.
    stream.end(() => {
      pending -= 1;
      if (pending === 0) process.exit(code);
    });
  }
}

exitWhenWritten(await main());
