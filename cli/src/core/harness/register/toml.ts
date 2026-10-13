import { AiregError, ErrorCode } from "#core/errors.ts";

// A line editor for the tables a harness config holds: it rewrites only the
// lines of the one table it is given, so a person's comments and layout survive.

export type TomlScalar = string | number | boolean;

const MAX_BYTES = 1_000_000;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function checked(text: string): void {
  if (text.length > MAX_BYTES) {
    throw new AiregError("A TOML config is too large to edit.", { code: ErrorCode.Invalid });
  }
  if (text.includes("\0")) {
    throw new AiregError("A TOML config is not text.", { code: ErrorCode.Invalid });
  }
}

/** The backslash and every control character escaped, except those in `kept`. */
function escaped(value: string, kept = ""): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (kept.includes(char)) out += char;
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out;
}

/** A basic string: the quote, the backslash and every control character escaped. */
export function quote(value: string): string {
  return `"${escaped(value).replaceAll('"', '\\"')}"`;
}

/** A multi-line basic string; a quote is escaped only where it would end the string early. */
export function multilineQuote(value: string): string {
  const text = escaped(value, "\n\t")
    .replace(/"+$/, (run) => run.replaceAll('"', '\\"'))
    .replace(/"{3,}/g, (run) => run.replaceAll('"""', '""\\"'));
  return `"""\n${text}"""`;
}

function renderKey(key: string): string {
  return BARE_KEY.test(key) ? key : quote(key);
}

function renderValue(value: TomlScalar): string {
  return typeof value === "string" ? quote(value) : String(value);
}

function heading(at: readonly string[]): string {
  return `[${at.map(renderKey).join(".")}]`;
}

/** A basic or literal string at the start of `raw`, and what follows it. */
function readString(raw: string): { value: string; rest: string } | undefined {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (basic !== null) {
    const value = (basic[1] ?? "").replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) => {
      if (escaped.startsWith("u") && escaped.length === 5) {
        return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
      }
      return escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
    });
    return { value, rest: raw.slice(basic[0].length) };
  }
  const literal = /^'([^']*)'/.exec(raw);
  if (literal !== null) return { value: literal[1] ?? "", rest: raw.slice(literal[0].length) };
  return undefined;
}

/** A dotted key, bare or quoted segments, at the start of `raw`, and what follows it. */
function readKey(raw: string): { keys: string[]; rest: string } | undefined {
  let rest = raw.trimStart();
  const keys: string[] = [];
  for (;;) {
    const string = readString(rest);
    if (string !== undefined) {
      keys.push(string.value);
      rest = string.rest.trimStart();
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(rest);
      if (bare === null) return undefined;
      keys.push(bare[0]);
      rest = rest.slice(bare[0].length).trimStart();
    }
    if (!rest.startsWith(".")) return { keys, rest };
    rest = rest.slice(1).trimStart();
  }
}

/** The segments of a `[table]` or `[[table]]` heading, or undefined for any other line. */
function parseHeading(line: string): { at: string[]; array: boolean } | undefined {
  const trimmed = line.trim();
  const array = trimmed.startsWith("[[");
  if (!trimmed.startsWith("[")) return undefined;
  const key = readKey(trimmed.slice(array ? 2 : 1));
  if (key === undefined) return undefined;
  const close = array ? /^\]\](\s*#.*)?$/ : /^\](\s*#.*)?$/;
  return close.test(key.rest) ? { at: key.keys, array } : undefined;
}

/** The key a `key = value` line sets, and its raw value. */
function parseEntry(line: string): { keys: string[]; raw: string } | undefined {
  const key = readKey(line);
  const value = key === undefined ? null : /^=\s*(.*)$/.exec(key.rest);
  return key === undefined || value === null ? undefined : { keys: key.keys, raw: value[1] ?? "" };
}

/** Null for a value this editor does not read, so it never equals one aireg would write. */
function parseValue(raw: string): TomlScalar | null {
  const string = readString(raw.trim());
  if (string !== undefined) return /^\s*(#.*)?$/.test(string.rest) ? string.value : null;
  const bare = raw.replace(/#.*$/, "").trim();
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  return null;
}

/** What a value left open at the end of a line: brackets, or a multi-line string. */
interface Open {
  depth: number;
  quote: string | undefined;
}

/** Where a basic string's closing `quote` sits at or after `from`, skipping escapes; -1 when absent. */
function basicClose(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text.startsWith(quote, i)) return i;
  }
  return -1;
}

/** Where `quote` closes at or after `from`; only a basic (double-quoted) string has escapes. */
function stringEnd(text: string, from: number, quote: string): number {
  return quote.startsWith('"') ? basicClose(text, from, quote) : text.indexOf(quote, from);
}

/** The string delimiter that starts at `i`, longest first, if one does. */
function quoteAt(text: string, i: number): string | undefined {
  const triple = text.slice(i, i + 3);
  if (triple === '"""' || triple === "'''") return triple;
  const char = text[i];
  return char === '"' || char === "'" ? char : undefined;
}

function nesting(char: string | undefined, depth: number): number {
  if (char === "[" || char === "{") return depth + 1;
  if (char === "]" || char === "}") return Math.max(0, depth - 1);
  return depth;
}

/** What is still open after one more line of a value, outside strings and comments. */
function carry(text: string, open: Open): Open {
  let { depth, quote } = open;
  let i = 0;
  while (i < text.length) {
    if (quote !== undefined) {
      const close = stringEnd(text, i, quote);
      if (close < 0) return { depth, quote };
      i = close + quote.length;
      quote = undefined;
      continue;
    }
    if (text[i] === "#") break;
    const opening = quoteAt(text, i);
    if (opening === undefined) {
      depth = nesting(text[i], depth);
      i += 1;
    } else if (opening.length === 3) {
      quote = opening;
      i += 3;
    } else {
      const close = stringEnd(text, i + 1, opening);
      i = close < 0 ? text.length : close + 1;
    }
  }
  return { depth, quote };
}

/** One heading or `key = value` line with the lines its value runs on to, or any other line. */
interface Statement {
  start: number;
  end: number;
  heading?: { at: string[]; array: boolean } | undefined;
  entry?: { keys: string[]; raw: string } | undefined;
}

function statements(lines: readonly string[]): Statement[] {
  const out: Statement[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const heading = parseHeading(line);
    const entry = heading === undefined ? parseEntry(line) : undefined;
    const closed: Open = { depth: 0, quote: undefined };
    let open = entry === undefined ? closed : carry(entry.raw, closed);
    let end = i + 1;
    while (end < lines.length && (open.depth > 0 || open.quote !== undefined)) {
      open = carry(lines[end] as string, open);
      end += 1;
    }
    out.push({ start: i, end, heading, entry });
    i = end;
  }
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length && prefix.every((key, index) => path[index] === key);
}

interface Span {
  lines: string[];
  nl: string;
  trailing: boolean;
  /** -1 when the table is absent. */
  start: number;
  end: number;
  /** The table's own `key = value` statements. */
  entries: (Statement & { entry: { keys: [string]; raw: string } })[];
  /** The file also sets the table by a dotted key, an inline table or `[[...]]`. */
  elsewhere: boolean;
}

function span(text: string, at: readonly string[]): Span {
  checked(text);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (trailing) lines.pop();
  let start = -1;
  let end = lines.length;
  let table: string[] = [];
  let inside = false;
  let elsewhere = false;
  const entries: Span["entries"] = [];
  for (const statement of statements(lines)) {
    const { heading, entry } = statement;
    if (heading !== undefined) {
      if (inside) end = statement.start;
      const named = heading.at.length === at.length && startsWith(heading.at, at);
      inside = named && !heading.array;
      if (inside) start = statement.start;
      elsewhere ||= named && heading.array;
      table = heading.at;
    } else if (entry !== undefined) {
      if (inside && entry.keys.length === 1) entries.push(statement as Span["entries"][number]);
      else elsewhere ||= !inside && startsWith([...table, ...entry.keys], at);
    }
  }
  return { lines, nl, trailing, start, end, entries, elsewhere };
}

function render({ nl, trailing }: Span, lines: readonly string[]): string {
  const rendered = lines.join(nl);
  return rendered === "" ? "" : trailing ? `${rendered}${nl}` : rendered;
}

/** The keys the table at `at` sets, or undefined when there is no such table. */
export function readTable(
  text: string,
  at: readonly string[],
): Record<string, TomlScalar | null> | undefined {
  const { start, entries } = span(text, at);
  if (start < 0) return undefined;
  const out: Record<string, TomlScalar | null> = {};
  for (const { start: first, end, entry } of entries) {
    out[entry.keys[0]] = end - first === 1 ? parseValue(entry.raw) : null;
  }
  return out;
}

/** The table's lines with each of its entries passed through `edit`, which may drop or replace it. */
function rewrite(
  found: Span,
  edit: (key: string) => string | null | undefined,
  added: readonly string[] = [],
): string {
  const { lines, start, end, entries } = found;
  const body: string[] = [];
  let at = start + 1;
  for (const statement of entries) {
    body.push(...lines.slice(at, statement.start));
    const next = edit(statement.entry.keys[0]);
    if (next === undefined) body.push(...lines.slice(statement.start, statement.end));
    else if (next !== null) body.push(next);
    at = statement.end;
  }
  body.push(...lines.slice(at, end));
  return render(found, [...lines.slice(0, start + 1), ...added, ...body, ...lines.slice(end)]);
}

/** Sets each key in the table at `at`, in place where it is already set. Other keys are kept. */
export function setKeys(
  text: string,
  at: readonly string[],
  values: Readonly<Record<string, TomlScalar>>,
): string {
  const found = span(text, at);
  const { lines, nl, start } = found;
  // A heading of its own beside a dotted key or inline table would leave a file the harness refuses.
  if (found.elsewhere) {
    throw new AiregError(
      `A TOML config sets ${heading(at)} other than under its own heading, which aireg does not edit.`,
      { code: ErrorCode.Invalid, hint: `Move those keys under a ${heading(at)} heading.` },
    );
  }
  const line = (key: string, value: TomlScalar) => `${renderKey(key)} = ${renderValue(value)}`;
  if (start < 0) {
    const body = Object.entries(values).map(([key, value]) => line(key, value));
    const prefix = text === "" ? "" : `${lines.join(nl)}${nl}${nl}`;
    return `${prefix}${heading(at)}${nl}${body.join(nl)}${nl}`;
  }
  const missing = new Set(Object.keys(values));
  for (const { entry } of found.entries) missing.delete(entry.keys[0]);
  return rewrite(
    found,
    (key) => (Object.hasOwn(values, key) ? line(key, values[key] as TomlScalar) : undefined),
    [...missing].map((key) => line(key, values[key] as TomlScalar)),
  );
}

/** Deletes each key from the table at `at`, leaving the table itself. */
export function unsetKeys(text: string, at: readonly string[], keys: readonly string[]): string {
  const found = span(text, at);
  if (found.start < 0) return text;
  return rewrite(found, (key) => (keys.includes(key) ? null : undefined));
}

/** Deletes the table at `at` and the blank lines that set it apart. */
export function dropTable(text: string, at: readonly string[]): string {
  const found = span(text, at);
  const { lines, start, end } = found;
  if (start < 0) return text;
  let from = start;
  while (from > 0 && (lines[from - 1] ?? "").trim() === "") from -= 1;
  let to = end;
  if (from === 0) while (to < lines.length && (lines[to] ?? "").trim() === "") to += 1;
  return render(found, [
    ...lines.slice(0, from),
    ...(from > 0 && to < lines.length ? [""] : []),
    ...lines.slice(to),
  ]);
}
