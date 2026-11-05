import { messageOf } from "#adapter/errors.ts";
import { list, quoted, sanitizeText } from "#adapter/text.ts";
import { LOGS_COMMAND } from "#cli/commands/logs/spec.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isLevel, LEVELS, type LogRecord } from "#core/log/model.ts";
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
import type { CommandContext } from "./command.ts";

interface Own extends Record<string, unknown> {
  follow?: boolean;
  tail?: string;
  since?: string;
  until?: string;
  level?: string;
  grep?: string;
  daemon?: boolean;
  cli?: boolean;
  stderr?: boolean;
  previous?: boolean;
}

const DEFAULT_TAIL = 50;

export async function run(context: CommandContext): Promise<void> {
  const { positionals, own } = parse<Own>(context.argv, LOGS_COMMAND);
  noArguments(positionals, "logs");

  const home = toolHome();
  const chosen = sources(own, home);
  const filter = filterOf(own);

  const limit = own.tail === undefined ? DEFAULT_TAIL : Number(own.tail);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new AiregError(`--tail takes a whole number, not ${quoted(own.tail ?? "")}.`, {
      code: ErrorCode.Usage,
      hint: "Pass how many entries to print, such as `--tail 20`.",
    });
  }

  // Each log is in time order, so the newest of all are among each one's newest.
  const history = chosen
    .flatMap((source) =>
      newestEntries(source.path, filter, limit).map((entry) => ({ log: source.label, entry })),
    )
    .sort((a, b) => {
      const at = isRaw(a.entry) ? "" : a.entry.timestamp;
      const bt = isRaw(b.entry) ? "" : b.entry.timestamp;
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

  const newest = limit === 0 ? [] : history.slice(-limit);
  // One document for what is there; only a follow streams, one line per entry.
  if (context.printer.format === "json" && own.follow !== true) {
    context.printer.json({ ok: true, data: { entries: newest } });
    return;
  }
  // `--tail 0` asked for no entries, so finding none is not news.
  if (history.length === 0 && limit > 0 && own.follow !== true) {
    context.printer.info("No log entries yet.");
    context.printer.info(
      context.printer.style.dim(
        "Commands you run log only with `--log-level`. The daemon logs whenever it runs.",
      ),
    );
    return;
  }

  for (const { log, entry } of newest) render(context, log, entry);
  if (own.follow !== true) return;

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await Promise.all(
    chosen.map(async (source) => {
      for await (const line of follow({ path: source.path, signal: controller.signal })) {
        const entry = parseLine(line);
        if (entry !== undefined && matches(entry, filter)) render(context, source.label, entry);
      }
    }),
  );
}

interface Source {
  label: string;
  path: string;
}

function sources(own: Own, home: string): Source[] {
  const suffix = own.previous === true ? ".1" : "";
  const all: Source[] = [
    { label: "daemon", path: `${logPath(home, DAEMON_LOG_FILE)}${suffix}` },
    { label: "cli", path: `${logPath(home)}${suffix}` },
    { label: "stderr", path: `${logPath(home, DAEMON_STDERR_FILE)}${suffix}` },
  ];
  const wanted = new Set<string>();
  if (own.daemon === true) wanted.add("daemon");
  if (own.cli === true) wanted.add("cli");
  if (own.stderr === true) wanted.add("stderr");
  // Raw stderr is noise next to structured records, so it is opt-in.
  if (wanted.size === 0) return all.filter((source) => source.label !== "stderr");
  return all.filter((source) => wanted.has(source.label));
}

function filterOf(own: Own): Filter {
  const filter: Filter = {};
  if (own.level !== undefined) {
    if (!isLevel(own.level)) {
      throw new AiregError(`Unknown log level ${quoted(own.level)}.`, {
        code: ErrorCode.Usage,
        hint: `Use ${list(LEVELS, "or")}.`,
      });
    }
    filter.minLevel = own.level;
  }
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

function render(context: CommandContext, log: string, entry: Entry): void {
  const { printer } = context;
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

function paint(printer: CommandContext["printer"], level: LogRecord["severity_text"]): string {
  const text = level.toUpperCase().padEnd(5);
  if (level === "error" || level === "fatal") return printer.style.red(text);
  if (level === "warn") return printer.style.yellow(text);
  if (level === "info") return printer.style.cyan(text);
  return printer.style.dim(text);
}
