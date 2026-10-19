// A reader for the front matter of a SKILL.md or an agent file: the YAML subset those files use,
// read as text and never evaluated. Anything outside the subset is left out rather than guessed.

/** A value as front matter gives it: text, a list of text, or one level of text by key. */
type FrontmatterValue = string | string[] | Record<string, string>;

export interface Frontmatter {
  /** Each top-level key the reader understood. */
  data: Record<string, FrontmatterValue>;
  /** What follows the closing `---`. */
  body: string;
}

/** Front matter that is not a few kilobytes of fields is not front matter. */
const MAX_LINES = 1_000;

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A trailing ` # comment` ends a plain scalar; a `#` inside one does not. */
function plain(text: string): string {
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

function doubleQuoted(text: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
  if (match === null) return undefined;
  const escapes: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    '"': '"',
    "\\": "\\",
    "/": "/",
  };
  return (match[1] as string).replace(/\\(.)/g, (whole, char: string) => escapes[char] ?? whole);
}

function singleQuoted(text: string): string | undefined {
  const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
  return match === null ? undefined : (match[1] as string).replace(/''/g, "'");
}

/** One inline value: quoted, a flow list of plain items, or plain text. */
function scalar(text: string): string | string[] | undefined {
  if (text.startsWith('"')) return doubleQuoted(text);
  if (text.startsWith("'")) return singleQuoted(text);
  if (text.startsWith("[")) {
    const match = /^\[(.*)\]\s*(?:#.*)?$/.exec(text);
    if (match === null) return undefined;
    const inner = (match[1] as string).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => {
      const value = item.trim();
      return singleQuoted(value) ?? doubleQuoted(value) ?? value;
    });
  }
  // A flow map or an anchor is outside the subset.
  if (/^[{&*!|>]/.test(text)) return undefined;
  return plain(text);
}

/** `|` keeps line breaks, `>` folds them into spaces; `-` drops the final one. */
function block(header: string, lines: readonly string[]): string {
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map(indentOf));
  const body = lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
  while (body.length > 0 && body.at(-1)?.trim() === "") body.pop();
  const text = header.startsWith(">")
    ? body.reduce((joined, line, index) => {
        if (index === 0) return line;
        if (line === "") return `${joined}\n`;
        return joined.endsWith("\n") ? `${joined}${line}` : `${joined} ${line}`;
      }, "")
    : body.join("\n");
  return header.includes("-") ? text : `${text}\n`;
}

/** The text items of a `- item` list, or one level of `key: value` pairs. */
function nestedValue(under: readonly string[]): FrontmatterValue {
  const items = under.filter((item) => item.trim() !== "");
  if (items.length === 0) return "";
  if (items.every((item) => item.trimStart().startsWith("- "))) {
    return items.map((item) => {
      const listed = item.trimStart().slice(2).trim();
      const read = scalar(listed);
      return typeof read === "string" ? read : listed;
    });
  }
  const map: Record<string, string> = {};
  for (const item of items) {
    const pair = KEY.exec(item.trim());
    const read = pair === null ? undefined : scalar((pair[2] ?? "").trim());
    if (pair !== null && typeof read === "string") map[pair[1] as string] = read;
  }
  return map;
}

/** One key's value, from what follows its colon and the lines indented under it. */
function readValue(value: string, under: readonly string[]): FrontmatterValue | undefined {
  if (value === "" || value.startsWith("#")) return nestedValue(under);
  if (/^[|>][+-]?$/.test(value)) return block(value, under);
  return scalar(value);
}

/** The lines indented under the key at `at`, which belong to it. */
function indentedAfter(lines: readonly string[], at: number): string[] {
  const taken: string[] = [];
  for (let next = at + 1; next < lines.length; next += 1) {
    const line = lines[next] as string;
    if (line.trim() !== "" && indentOf(line) === 0) break;
    taken.push(line);
  }
  return taken;
}

/**
 * The fields between a leading `---` line and the next `---`, or undefined when the text has
 * none. A line the subset does not cover is skipped, along with anything indented under it.
 */
export function readFrontmatter(text: string): Frontmatter | undefined {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1 || end > MAX_LINES) return undefined;

  const data: Record<string, FrontmatterValue> = {};
  const inner = lines.slice(1, end);
  for (let at = 0; at < inner.length; at += 1) {
    const line = inner[at] as string;
    const match = indentOf(line) === 0 ? KEY.exec(line) : null;
    if (match === null) continue;
    const under = indentedAfter(inner, at);
    at += under.length;
    const value = readValue((match[2] ?? "").trim(), under);
    if (value !== undefined) data[match[1] as string] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

/** A text field, when the front matter has one that is not empty. */
export function textField(front: Frontmatter | undefined, key: string): string | undefined {
  const value = front?.data[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
