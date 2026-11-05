import { MAX_SEGMENT } from "./filespec/names.ts";

const FALLBACK_NAME = "unnamed";

/**
 * Registry text is attacker-controlled: escapes can retitle the terminal, write the clipboard or fake
 * rows. Whole sequences go first, then controls but tab, newline and CR, then bidi (Trojan Source).
 */
const CONTROL_SEQUENCES = new RegExp(
  [
    "(?:\\u001B[\\]PX^_]|[\\u0090\\u0098\\u009D-\\u009F])[^\\u0007\\u001B\\u0090\\u0098\\u009B-\\u009F]*(?:\\u0007|\\u001B\\\\|\\u009C)",
    "(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]",
    "\\u001B[ -~]?",
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
    "[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  ].join("|"),
  "g",
);

/**
 * Reduce arbitrary text to one path segment the file spec accepts. The store
 * tree and the artifacts tree are keyed by this, so there is exactly one.
 */
export function sanitizeName(name: string): string {
  // Trimmed after truncating, so a cut landing on a separator still settles:
  // addresses are matched by comparing sanitized names, so this must be stable.
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, MAX_SEGMENT)
    .replace(/^-+|-+$/g, "");

  return sanitized || FALLBACK_NAME;
}

/** JSON leaves these as they are, and each can hide text or reorder it on screen. */
const INVISIBLE = /[\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/** Typed input quoted for a message, with every control and bidi character escaped. */
export function quoted(value: string): string {
  return JSON.stringify(value).replace(
    INVISIBLE,
    (char) => `\\u${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

/** Escapes, controls and bidi controls removed, whitespace folded, truncated: safe on one line. */
export function sanitizeText(text: string, maxLength = 200): string {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

function stripControl(text: string): string {
  return text.replace(CONTROL_SEQUENCES, "");
}

/**
 * Escapes and controls removed, lines and tabs kept: safe to print a whole file.
 * A lone carriage return goes too, since it can write one line over another.
 */
export function sanitizeBlock(text: string): string {
  return stripControl(text).replace(/\r(?!\n)/g, "");
}

/** `location` with its userinfo redacted, since a mistyped source can carry a token into logs. */
export function withoutCredentials(location: string): string {
  return replaceUserinfo(location, () => "<redacted>");
}

const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isSchemeChar = (code: number) =>
  isLetter(code) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 45 ||
  code === 46 ||
  code === 95;
const endsUserinfo = (char: string | undefined) =>
  char === undefined || char === "/" || char === "@" || /\s/.test(char);

/**
 * Every `scheme://userinfo@` in `text` with `replace`'s userinfo, undefined keeping it. One linear
 * pass, so hostile input cannot stall the CLI or the daemon.
 */
export function replaceUserinfo(
  text: string,
  replace: (userinfo: string) => string | undefined,
): string {
  let out = "";
  let copied = 0;
  let at = text.indexOf("://");
  while (at !== -1) {
    let start = at;
    while (start > 0 && isSchemeChar(text.charCodeAt(start - 1))) start -= 1;
    while (start < at && !isLetter(text.charCodeAt(start))) start += 1;
    let end = at + 3;
    if (start < at) {
      while (!endsUserinfo(text[end])) end += 1;
      if (text[end] === "@") {
        const next = replace(text.slice(at + 3, end));
        if (next !== undefined) {
          out += `${text.slice(copied, at + 3)}${next}`;
          copied = end;
        }
      }
    }
    at = text.indexOf("://", end);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** `text` less any trailing run of `chars`; `/\/+$/` would backtrack quadratically on a long run. */
export function stripTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** `text` less any leading run of `chars`. */
export function stripLeading(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text.charAt(start))) start += 1;
  return text.slice(start);
}

/** A count with its noun, singular only for 1. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function list(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}
