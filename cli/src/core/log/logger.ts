import type { Fields } from "#adapter/fields.ts";
import { serializeError } from "./error.ts";
import {
  LEVEL_WEIGHT,
  type Level,
  type Logger,
  type LogRecord,
  SEVERITY_NUMBER,
  type SerializedError,
  type Sink,
} from "./model.ts";
import { redactKeyedValue, redactText } from "./redact.ts";

interface LoggerOptions {
  sink: Sink;
  level: Level;
  bindings?: Fields;
}

const NULL_SINK: Sink = { write: () => {} };

export function createLogger(options: LoggerOptions): Logger {
  const { sink, level, bindings = {} } = options;
  const threshold = LEVEL_WEIGHT[level];

  function emit(severity: Level, message: string, fields?: Fields): void {
    // Before any formatting or scrubbing: a suppressed line must cost nothing.
    if (LEVEL_WEIGHT[severity] < threshold) return;

    const { error, ...rest } = { ...bindings, ...fields };
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      severity_text: severity,
      severity_number: SEVERITY_NUMBER[severity],
      body: message,
      attributes: redactKeyedValue(rest) as Fields,
    };
    if (error !== undefined) record.error = scrub(serializeError(error));
    sink.write(record);
  }

  return {
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
    enabled: (query) => LEVEL_WEIGHT[query] >= threshold,
    trace: (message, fields) => emit("trace", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    fatal: (message, fields) => emit("fatal", message, fields),
  };
}

function scrub(error: SerializedError): SerializedError {
  const scrubbed: SerializedError = { name: error.name, message: redactText(error.message) };
  if (error.code !== undefined) scrubbed.code = error.code;
  if (error.stack !== undefined) scrubbed.stack = redactText(error.stack);
  if (error.cause !== undefined) scrubbed.cause = scrub(error.cause);
  return scrubbed;
}

/** Discards everything, so a caller never branches on whether logging is on. */
export function nullLogger(): Logger {
  return createLogger({ sink: NULL_SINK, level: "fatal" });
}
