import { messageOf } from "#adapter/errors.ts";
import { sanitizeText } from "#adapter/text.ts";
import type { LogName, LogsResult } from "#cli/commands/logs/result.ts";
import { LOGS_COMMAND } from "#cli/commands/logs/spec.ts";
import { noArguments, type OptionsOf, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { LogRecord } from "#core/log/model.ts";
import {
  type Entry,
  type Filter,
  isRaw,
  matches,
  newestEntries,
  parseLine,
  parseSince,
} from "#core/log/read.ts";
import { DAEMON_LOG_FILE, DAEMON_STDERR_FILE, logPath } from "#core/log/sink.ts";
import { follow } from "#core/log/tail.ts";
import { toolHome } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { defineCommand, STREAMED } from "./define.ts";

type Options = OptionsOf<typeof LOGS_COMMAND.options>;

const DEFAULT_TAIL = 50;

export const { run } = defineCommand({
  spec: LOGS_COMMAND,
  parse(argv): Options {
    const { positionals, own } = parse<Options>(argv, LOGS_COMMAND);
    noArguments(positionals, "logs");
    return own;
  },
  async run(options, context): Promise<LogsResult | typeof STREAMED> {
    const chosen = sources(options, toolHome());
    const filter = filterOf(options);
    const limit = options.tail ?? DEFAULT_TAIL;

    // Each log is in time order, so the newest of all are among each one's newest.
    const history = chosen
      .flatMap((source) =>
        newestEntries(source.path, filter, limit).map((entry) => ({ log: source.label, entry })),
      )
      .sort((a, b) => {
        const at = isRaw(a.entry) ? "" : a.entry.timestamp;
        const bt = isRaw(b.entry) ? "" : b.entry.timestamp;
        if (at < bt) return -1;
        return at > bt ? 1 : 0;
      });
    const entries = limit === 0 ? [] : history.slice(-limit);
    if (options.follow !== true) return { entries };

    for (const { log, entry } of entries) render(context.printer, log, entry);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await Promise.all(
      chosen.map(async (source) => {
        for await (const line of follow({ path: source.path, signal: controller.signal })) {
          const entry = parseLine(line);
          if (entry !== undefined && matches(entry, filter)) {
            render(context.printer, source.label, entry);
          }
        }
      }),
    );
    return STREAMED;
  },
  text(result, printer, options) {
    // `--tail 0` asked for no entries, so finding none is not news.
    if (result.entries.length === 0 && options.tail !== 0) {
      printer.info("No log entries yet.");
      printer.info(
        printer.style.dim(
          "Commands you run log only with `--log-level`. The daemon logs whenever it runs.",
        ),
      );
      return;
    }
    for (const { log, entry } of result.entries) render(printer, log, entry);
  },
});

interface Source {
  label: LogName;
  path: string;
}

function sources(own: Options, home: string): Source[] {
  const suffix = own.previous === true ? ".1" : "";
  const all: Source[] = [
    { label: "daemon", path: `${logPath(home, DAEMON_LOG_FILE)}${suffix}` },
    { label: "cli", path: `${logPath(home)}${suffix}` },
    { label: "stderr", path: `${logPath(home, DAEMON_STDERR_FILE)}${suffix}` },
  ];
  const wanted = new Set<LogName>();
  if (own.daemon === true) wanted.add("daemon");
  if (own.cli === true) wanted.add("cli");
  if (own.stderr === true) wanted.add("stderr");
  // Raw stderr is noise next to structured records, so it is opt-in.
  if (wanted.size === 0) return all.filter((source) => source.label !== "stderr");
  return all.filter((source) => wanted.has(source.label));
}

function filterOf(own: Options): Filter {
  const filter: Filter = {};
  if (own.level !== undefined) filter.minLevel = own.level;
  try {
    if (own.since !== undefined) filter.sinceMs = parseSince(own.since);
    if (own.until !== undefined) filter.untilMs = parseSince(own.until);
  } catch (error) {
    throw new AiregError(messageOf(error), {
      code: ErrorCode.Usage,
      hint: "Use a duration such as 15m, or a date.",
    });
  }
  if (own.grep !== undefined) filter.contains = own.grep;
  return filter;
}

function render(printer: Printer, log: LogName, entry: Entry): void {
  if (printer.format === "json") {
    printer.json({ ok: true, data: { log, entry } });
    return;
  }
  if (isRaw(entry)) {
    printer.info(`${printer.style.dim(`${log} raw`)}  ${sanitizeText(entry.raw, 2000)}`);
    return;
  }
  const record = entry as LogRecord;
  const time = record.timestamp.slice(11, 23);
  const level = paint(printer, record.severity_text);
  const fields = Object.entries(record.attributes)
    .filter(([key]) => !key.startsWith("service.") && key !== "pid")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const error =
    record.error === undefined
      ? ""
      : ` ${sanitizeText(`${record.error.name}: ${record.error.message}`, 2000)}`;
  printer.info(
    `${printer.style.dim(time)} ${level} ${sanitizeText(record.body, 2000)}${error}` +
      (fields === "" ? "" : ` ${printer.style.dim(sanitizeText(fields, 2000))}`),
  );
}

function paint(printer: Printer, level: LogRecord["severity_text"]): string {
  const text = level.toUpperCase().padEnd(5);
  if (level === "error" || level === "fatal") return printer.style.red(text);
  if (level === "warn") return printer.style.yellow(text);
  if (level === "info") return printer.style.cyan(text);
  return printer.style.dim(text);
}
