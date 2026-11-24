import type { RegistryUsage } from "./contract.ts";
import { isRecord, textOf } from "./fields.ts";

const REPORTERS = ["pseudonym", "name"] as const;
const PRECISIONS = ["second", "hour", "day"] as const;
const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.[0-9.]+|\[::1\])(:[0-9]+)?(\/|$)/;

/**
 * A usage block a client may follow (file spec sections 11 and 14.1), from `registry.json`'s
 * `{otlp, reporter, time_precision}` or an adapter's `{otlp, reporter, timePrecision}`. One it may
 * not, such as plain http to another host, reads as no usage at all: sending nothing is the safe
 * way to misread it.
 */
export function usageOf(value: unknown): RegistryUsage | undefined {
  if (!isRecord(value)) return undefined;
  const otlp = textOf(value.otlp)?.replace(/\/+$/, "");
  if (otlp === undefined || !(otlp.startsWith("https://") || LOOPBACK_HTTP.test(otlp))) {
    return undefined;
  }
  if (otlp.endsWith("/v1/traces")) return undefined;
  const reporter = oneOf(value.reporter, REPORTERS, "pseudonym");
  const timePrecision = oneOf(value.timePrecision ?? value.time_precision, PRECISIONS, "hour");
  if (reporter === undefined || timePrecision === undefined) return undefined;
  return { otlp, reporter, timePrecision };
}

/** The default when absent; undefined when present but not one of `values`. */
function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T | undefined {
  if (value === undefined) return fallback;
  return values.find((item) => item === value);
}
