import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isRecord } from "#adapter/fields.ts";
import { isAbsent } from "#adapter/files.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { parseDuration } from "#core/fields.ts";
import type { Level, LogRecord } from "./model.ts";
import { isLevel, LEVEL_WEIGHT } from "./model.ts";

export interface Filter {
  minLevel?: Level;
  sinceMs?: number;
  untilMs?: number;
  contains?: string;
}

/** A line the logger did not write, such as raw stderr captured beside it. */
interface RawLine {
  raw: string;
}

export type Entry = LogRecord | RawLine;

export function isRaw(entry: Entry): entry is RawLine {
  return "raw" in entry;
}

export function parseLine(line: string): Entry | undefined {
  const text = line.trim();
  if (text === "") return undefined;
  if (!text.startsWith("{")) return { raw: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Captured output that only starts like JSON.
    return { raw: text };
  }
  return isLogRecord(value) ? value : { raw: text };
}

/** A line that lacks any field a reader takes stays raw. */
function isLogRecord(value: unknown): value is LogRecord {
  return (
    isRecord(value) &&
    typeof value.body === "string" &&
    typeof value.timestamp === "string" &&
    isLevel(String(value.severity_text)) &&
    isRecord(value.attributes) &&
    (value.error === undefined || isRecord(value.error))
  );
}

export function matches(entry: Entry, filter: Filter): boolean {
  if (isRaw(entry)) {
    // Raw lines have no level or timestamp to compare, so only text filters apply.
    return filter.contains === undefined || entry.raw.includes(filter.contains);
  }
  if (filter.minLevel !== undefined) {
    if (LEVEL_WEIGHT[entry.severity_text] < LEVEL_WEIGHT[filter.minLevel]) return false;
  }
  if (filter.sinceMs !== undefined || filter.untilMs !== undefined) {
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) return false;
    if (filter.sinceMs !== undefined && at < filter.sinceMs) return false;
    if (filter.untilMs !== undefined && at > filter.untilMs) return false;
  }
  if (filter.contains !== undefined && !JSON.stringify(entry).includes(filter.contains)) {
    return false;
  }
  return true;
}

const CHUNK_BYTES = 64 * 1024;

/** Oldest first; read from the end, so a big log is cheap. */
export function newestEntries(path: string, filter: Filter, limit: number): Entry[] {
  if (limit <= 0) return [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (isAbsent(error)) return [];
    // Often a log the daemon wrote while run with sudo: say which file, not a bare EACCES.
    if ((error as NodeJS.ErrnoException).code === "EACCES") {
      throw new AiregError(`Cannot read ${path}: permission denied.`, {
        hint: `Run \`chmod u+r ${path}\`, or remove it and the daemon writes a new one.`,
      });
    }
    throw error;
  }
  const found: Entry[] = [];
  const take = (line: Buffer) => {
    const entry = parseLine(line.toString("utf8"));
    if (entry !== undefined && matches(entry, filter)) found.push(entry);
  };
  try {
    let position = fstatSync(fd).size;
    // The end of a line whose start lies in a chunk not read yet.
    let partial = Buffer.alloc(0);
    while (position > 0 && found.length < limit) {
      const size = Math.min(CHUNK_BYTES, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, position);
      const buffer = Buffer.concat([chunk, partial]);
      // A newline byte never occurs inside a UTF-8 character, so splitting on it is safe.
      let end = buffer.length;
      while (end > 0 && found.length < limit) {
        const at = buffer.lastIndexOf(10, end - 1);
        if (at === -1) break;
        take(buffer.subarray(at + 1, end));
        end = at;
      }
      partial = buffer.subarray(0, end);
    }
    if (position === 0 && found.length < limit && partial.length > 0) take(partial);
  } finally {
    closeSync(fd);
  }
  return found.reverse();
}

/** `--since 15m` reads as a duration before now; anything else must parse as a date. */
export function parseSince(value: string, now = Date.now()): number {
  // A bare number would read as a year, so a duration here names its unit.
  const ago = /[smhd]$/.test(value.trim()) ? parseDuration(value) : undefined;
  if (ago !== undefined) return now - ago;
  const absolute = Date.parse(value);
  if (Number.isNaN(absolute)) {
    throw new AiregError(`Cannot read ${quoted(value)} as a time or a duration.`, {
      code: ErrorCode.Usage,
      hint: "Pass a duration such as 15m, 2h or 1d, or a date such as 2026-01-31.",
    });
  }
  return absolute;
}
