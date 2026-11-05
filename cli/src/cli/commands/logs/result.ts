import type { LogRecord } from "#core/log/model.ts";

/** The daemon's log, the CLI's, and the daemon's raw stderr. */
export type LogName = "daemon" | "cli" | "stderr";

/** A line that is not a record, as stderr holds; kept whole rather than dropped. */
interface RawLine {
  raw: string;
}

interface LogEntry {
  log: LogName;
  entry: LogRecord | RawLine;
}

/** The newest entries across the logs read, oldest first. */
export interface LogsResult {
  entries: LogEntry[];
}
