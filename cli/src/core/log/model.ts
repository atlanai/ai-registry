import type { Fields } from "#adapter/fields.ts";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

/** Ascending, so a threshold comparison is `>=`. */
export const LEVEL_WEIGHT: Record<Level, number> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

export function isLevel(value: string): value is Level {
  return value in LEVEL_WEIGHT;
}

/** Base of each OTel range, so the sub-levels stay available to an exporter. */
export const SEVERITY_NUMBER: Record<Level, number> = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
});

export interface SerializedError {
  name: string;
  message: string;
  /** The error's own `failure` or `code`. */
  code?: string;
  /** Present only for errors the codebase did not classify: see `error.ts`. */
  stack?: string;
  cause?: SerializedError;
}

/** Field names follow the OTel log data model, so a collector reads the file without a rewrite. */
export interface LogRecord {
  timestamp: string;
  severity_text: Level;
  severity_number: number;
  body: string;
  attributes: Record<string, unknown>;
  error?: SerializedError;
}

export interface Sink {
  write(record: LogRecord): void;
  /** Called before the process exits; a short-lived daemon must not lose its tail. */
  close?(): void;
}

/**
 * One signature at every level, because a warning carries a cause as often as
 * an error does. `error` is lifted out of the fields and serialized.
 */
export interface Logger {
  /** Bind context once per unit of work; every line below carries it. */
  child(bindings: Fields): Logger;
  /** True when the level would be emitted, for callers building costly fields. */
  enabled(level: Level): boolean;
  trace(message: string, fields?: Fields): void;
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  fatal(message: string, fields?: Fields): void;
}
