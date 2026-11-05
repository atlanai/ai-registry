import type { LogRecord, Sink } from "#core/log/model.ts";

/** A sink that keeps every record it is handed, for a test to read back. */
export function memorySink(): Sink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => void records.push(record) };
}
