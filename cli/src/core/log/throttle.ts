import { LEVEL_WEIGHT, type LogRecord, type Sink } from "./model.ts";

interface ThrottleOptions {
  /** How long identical records are collapsed for. */
  windowMs?: number;
  /** Distinct messages tracked at once, so a varying key cannot grow the map. */
  maxKeys?: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 256;

interface Seen {
  suppressed: number;
  openedAtMs: number;
  /** The newest record swallowed, which a count left at the end is reported on. */
  last: LogRecord;
}

/**
 * A stuck job re-reports the same failure every tick, which would evict
 * everything else from the kept files within a day.
 */
export function throttleSink(inner: Sink, options: ThrottleOptions = {}): Sink {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const seen = new Map<string, Seen>();
  // A count is otherwise reported only by the next identical record, which may never come.
  const flush = () => {
    for (const { suppressed, last } of seen.values()) {
      if (suppressed > 0) inner.write(repeated(last, suppressed));
    }
    seen.clear();
  };

  return {
    write(record: LogRecord): void {
      // Only a failure repeats itself: each info line is its own event, such as one
      // run starting, and debug and trace are written only when someone asked for them.
      if (LEVEL_WEIGHT[record.severity_text] < LEVEL_WEIGHT.warn) {
        inner.write(record);
        return;
      }
      const key = keyOf(record);
      const parsed = Date.parse(record.timestamp);
      const at = Number.isNaN(parsed) ? Date.now() : parsed;
      const previous = seen.get(key);

      if (previous !== undefined && at - previous.openedAtMs < windowMs) {
        previous.suppressed += 1;
        previous.last = record;
        return;
      }

      if (previous === undefined && seen.size >= maxKeys) flush();
      seen.set(key, { suppressed: 0, openedAtMs: at, last: record });
      inner.write(
        previous === undefined || previous.suppressed === 0
          ? record
          : repeated(record, previous.suppressed),
      );
    },
    close: () => {
      flush();
      inner.close?.();
    },
  };
}

function repeated(record: LogRecord, times: number): LogRecord {
  return { ...record, attributes: { ...record.attributes, repeated: times } };
}

/** One job's repeated failure collapses; another job's, or another cause, still shows. */
function keyOf(record: LogRecord): string {
  const { jobId, errorCode } = record.attributes as { jobId?: unknown; errorCode?: unknown };
  return JSON.stringify([
    record.severity_text,
    record.body,
    record.error?.name ?? "",
    typeof jobId === "string" ? jobId : "",
    typeof errorCode === "string" ? errorCode : "",
  ]);
}
