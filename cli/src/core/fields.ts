import { type Fields, isRecord, textOf } from "#adapter/fields.ts";
import { list, quoted } from "#adapter/text.ts";

/** Names that would reach an object's prototype when used as a map key. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** No prototype, so a key a registry chose, such as `__proto__`, is only ever a key. */
export function dict<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** A non-empty list of non-blank strings, or undefined. */
export function namesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => textOf(item) !== undefined) ? (value as string[]) : undefined;
}

/** Non-blank strings under non-blank keys, or undefined. */
export function textMapOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => key.trim() === "" || textOf(item) === undefined)) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Sorted so a message reads the same each time. */
export function unknownKeys(entry: Fields, known: readonly string[]): string[] {
  return Object.keys(entry)
    .filter((key) => !known.includes(key))
    .sort();
}

export function unknownKeysProblem(
  entry: Fields,
  known: readonly string[],
  owner: string,
): string | undefined {
  const extra = unknownKeys(entry, known);
  if (extra.length === 0) return undefined;
  return `${owner} does not take ${list(extra.map(quoted))}; it takes ${list([...known].sort())}.`;
}

export function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** A record holding nothing it does not name: a signed shape, not a superset of it. */
export function hasOnly(value: unknown, known: readonly string[]): value is Fields {
  return isRecord(value) && unknownKeys(value, known).length === 0;
}

/** Readers that refuse a bad field with the caller's error, naming it `<where>.<key>`. */
export interface Readers {
  /** The caller's error, for a rule no reader here knows. */
  fail(message: string): Error;
  record(value: unknown, where: string): Fields;
  onlyKnown(entry: Fields, known: readonly string[], where: string): void;
  text(entry: Fields, key: string, where?: string): string;
  optionalText(entry: Fields, key: string, where?: string): string | undefined;
  flag(entry: Fields, key: string, where?: string): boolean;
  optionalFlag(entry: Fields, key: string, fallback: boolean, where?: string): boolean;
  integer(entry: Fields, key: string, where?: string): number;
  oneOf<T extends string>(entry: Fields, key: string, allowed: readonly T[], where?: string): T;
  choice<T extends string>(
    entry: Fields,
    key: string,
    allowed: readonly T[],
    fallback: T,
    where?: string,
  ): T;
  /** A list, possibly empty, of non-blank strings. */
  textList(value: unknown, where: string): string[];
}

/** `record` is how the document names a mapping: `a mapping` in YAML, `an object` in JSON. */
export function readers(fail: (message: string) => Error, record = "an object"): Readers {
  const field = (key: string, where: string | undefined) =>
    `\`${where === undefined || where === "" ? key : `${where}.${key}`}\``;

  const text = (entry: Fields, key: string, where?: string): string => {
    const value = textOf(entry[key]);
    if (value === undefined) throw fail(`${field(key, where)} must be a non-empty string.`);
    return value;
  };
  const flag = (entry: Fields, key: string, where?: string): boolean => {
    const value = entry[key];
    if (typeof value !== "boolean") throw fail(`${field(key, where)} must be true or false.`);
    return value;
  };
  const oneOf = <T extends string>(
    entry: Fields,
    key: string,
    allowed: readonly T[],
    where?: string,
  ): T => {
    const value = text(entry, key, where);
    if (!(allowed as readonly string[]).includes(value)) {
      throw fail(`${field(key, where)} must be ${list(allowed, "or")}.`);
    }
    return value as T;
  };

  return {
    fail,
    record(value, where) {
      if (!isRecord(value)) throw fail(`\`${where}\` must be ${record}.`);
      return value;
    },
    onlyKnown(entry, known, where) {
      const problem = unknownKeysProblem(entry, known, where === "" ? "The file" : `\`${where}\``);
      if (problem !== undefined) throw fail(problem);
    },
    text,
    optionalText: (entry, key, where) =>
      entry[key] === undefined ? undefined : text(entry, key, where),
    flag,
    optionalFlag: (entry, key, fallback, where) =>
      entry[key] === undefined ? fallback : flag(entry, key, where),
    integer(entry, key, where) {
      const value = entry[key];
      if (!Number.isSafeInteger(value)) throw fail(`${field(key, where)} must be a whole number.`);
      return value as number;
    },
    oneOf,
    choice: (entry, key, allowed, fallback, where) =>
      entry[key] === undefined ? fallback : oneOf(entry, key, allowed, where),
    textList(value, where) {
      if (!Array.isArray(value)) throw fail(`\`${where}\` must be a list of strings.`);
      if (value.some((item) => textOf(item) === undefined)) {
        throw fail(`\`${where}\` must list only non-empty strings.`);
      }
      return value as string[];
    },
  };
}

const DURATION = /^(\d+)([smhd])?$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `900`, `15m`, `2h` or `1d` as milliseconds, a bare number being seconds; else undefined. */
export function parseDuration(text: string): number | undefined {
  const matched = DURATION.exec(text.trim());
  if (matched === null) return undefined;
  return Number(matched[1]) * (UNIT_MS[matched[2] ?? "s"] as number);
}
