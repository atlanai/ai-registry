import type { LogRecord, Sink } from "#core/log/model.ts";

export function memorySink(): Sink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (record) => void records.push(record) };
}
