import stringWidth from "string-width";
import { abbreviate } from "./printer.ts";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const ESC = "\u001B";
/** What follows `ESC [` in a control sequence: parameters, then one final byte. */
export const CSI_BODY = /^[0-?]*[ -/]*[@-~]/;

/** A CSI, or an OSC ended by BEL or ST. */
function escapeLength(text: string): number {
  if (text[1] === "[") return 2 + (CSI_BODY.exec(text.slice(2))?.[0].length ?? 0);
  if (text[1] === "]") {
    const ends = [text.indexOf("\u0007"), text.indexOf(`${ESC}\\`)].filter((at) => at !== -1);
    if (ends.length === 0) return text.length;
    const end = Math.min(...ends);
    return end + (text[end] === ESC ? 2 : 1);
  }
  return 1;
}

/** One grapheme or one escape sequence. */
export interface Cell {
  text: string;
  width: number;
}

/** Graphemes and styling escapes in order, so a cut never splits either. */
export function cells(text: string): Cell[] {
  const out: Cell[] = [];
  const plain = (part: string): void => {
    for (const { segment } of GRAPHEMES.segment(part)) {
      out.push({ text: segment, width: stringWidth(segment) });
    }
  };
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(ESC, from);
    plain(text.slice(from, at === -1 ? text.length : at));
    if (at === -1) break;
    const length = escapeLength(text.slice(at));
    out.push({ text: text.slice(at, at + length), width: 0 });
    from = at + length;
  }
  return out;
}

/** In terminal cells, ignoring styling. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(value: number): string {
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || n >= 100 ? Math.round(n) : Number(n.toFixed(1));
  return `${rounded} ${UNITS[unit]}`;
}

export function clock(atMs: number | undefined): string {
  if (atMs === undefined) return "--:--";
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Coarse relative time, past or future; `-` when undefined. */
export function ago(atMs: number | undefined, nowMs = Date.now()): string {
  if (atMs === undefined) return "-";
  const delta = nowMs - atMs;
  const abs = Math.abs(delta);
  if (abs < 45_000) return delta < 0 ? "in a moment" : "just now";
  const text = coarse(abs / 60_000);
  return delta < 0 ? `in ${text}` : `${text} ago`;
}

function coarse(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

export function shortDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function interval(seconds: number): string {
  return `every ${shortDuration(seconds)}`;
}

export function cut(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const cell of cells(text)) {
    if (used + cell.width > width) break;
    out += cell.text;
    used += cell.width;
  }
  return out;
}

/** Measured in cells, so CJK and emoji fit too. */
export function truncate(value: string, width: number): string {
  if (width <= 1) return cut(value, Math.max(0, width));
  return displayWidth(value) <= width ? value : `${cut(value, width - 1)}…`;
}

/** Keeps the tail, which is the part of a long path that identifies it. */
export function truncateStart(value: string, width: number): string {
  if (width <= 1 || displayWidth(value) <= width) return value;
  let tail = "";
  let used = 0;
  for (const cell of cells(value).reverse()) {
    if (used + cell.width > width - 1) break;
    tail = cell.text + tail;
    used += cell.width;
  }
  return `…${tail}`;
}

export function pad(value: string, width: number): string {
  const fitted = truncate(value, width);
  return fitted + " ".repeat(Math.max(0, width - displayWidth(fitted)));
}

export function shortDigest(digest: string | undefined): string {
  return digest === undefined || digest === "" ? "-" : abbreviate(digest);
}

export function bar(done: number, total: number, width: number): string {
  if (total <= 0) return "\u2591".repeat(width);
  const exact = (done / total) * width;
  // Never full while work is outstanding, or rounding up would make it look finished.
  const filled =
    done >= total ? width : Math.min(width - 1, Math.max(done > 0 ? 1 : 0, Math.round(exact)));
  return `${"\u2593".repeat(filled)}${"\u2591".repeat(width - filled)}`;
}

/** Day heading for a dated list, relative for today and yesterday. */
export function day(atMs: number, nowMs = Date.now()): string {
  const start = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
  const days = Math.round((start(nowMs) - start(atMs)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Single-quoted only when the shell would not read it back unchanged. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
