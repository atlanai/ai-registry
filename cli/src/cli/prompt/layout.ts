import { cells, cut, displayWidth, ESC } from "#core/term/format.ts";
import type { Styler } from "#core/term/printer.ts";
import { GLYPH } from "#core/term/theme.ts";

/**
 * Exactly `count` lines of at most `width` cells, so the frame never changes
 * height. The last line takes what is left and marks a cut with an ellipsis.
 */
export function fitLines(text: string | undefined, width: number, count: number): string[] {
  let words = (text ?? "").split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  while (lines.length < count && words.length > 0) {
    const rest = words.join(" ");
    if (displayWidth(rest) <= width) {
      lines.push(rest);
      words = [];
    } else if (lines.length === count - 1) {
      lines.push(ellipsized(words, width));
      words = [];
    } else {
      const [line, left] = filled(words, width);
      lines.push(line);
      words = left;
    }
  }
  while (lines.length < count) lines.push("");
  return lines;
}

function ellipsized(words: readonly string[], width: number): string {
  let kept = "";
  for (const word of words) {
    const next = kept === "" ? word : `${kept} ${word}`;
    if (displayWidth(next) + 1 > width) break;
    kept = next;
  }
  return `${kept === "" ? cut(words.join(" "), width - 1) : kept}…`;
}

/** One line's worth of words; a word longer than the line is split. */
function filled(words: readonly string[], width: number): [string, string[]] {
  const [first = "", ...others] = words;
  if (displayWidth(first) > width) {
    const head = cut(first, width);
    return [head, [first.slice(head.length), ...others].filter((word) => word !== "")];
  }
  let line = first;
  let taken = 1;
  // Strictly less, leaving the last cell free on every line but the final one.
  while (taken < words.length && displayWidth(`${line} ${words[taken]}`) < width) {
    line = `${line} ${words[taken]}`;
    taken += 1;
  }
  return [line, words.slice(taken)];
}

const RESETS = new Set([`${ESC}[0m`, `${ESC}[m`]);

/**
 * A styled line as the terminal rows it fills, breaking where the terminal
 * would. Each row reopens the styling the previous one left open.
 */
export function wrapRows(line: string, columns: number): string[] {
  const rows: string[] = [];
  let open: string[] = [];
  let row = "";
  let used = 0;
  for (const cell of cells(line)) {
    if (cell.width > 0 && used > 0 && used + cell.width > columns) {
      rows.push(open.length > 0 ? `${row}${ESC}[0m` : row);
      row = open.join("");
      used = 0;
    }
    row += cell.text;
    used += cell.width;
    if (cell.width === 0 && cell.text.startsWith(`${ESC}[`) && cell.text.endsWith("m")) {
      open = RESETS.has(cell.text) ? [] : [...open, cell.text];
    }
  }
  rows.push(row);
  return rows;
}

export function heightOf(lines: readonly string[], columns: number): number {
  return lines.reduce((sum, line) => sum + wrapRows(line, columns).length, 0);
}

export type Mark = "active" | "submit" | "cancel";

/** The question line every prompt opens with, and collapses to once answered. */
export function titleLine(style: Styler, mark: Mark, message: string, aside?: string): string {
  const glyph =
    mark === "active"
      ? style.green(GLYPH.active)
      : mark === "submit"
        ? style.green(GLYPH.submit)
        : style.red(GLYPH.cancel);
  return `${glyph}  ${style.bold(message)}${aside === undefined ? "" : `  ${aside}`}`;
}

export function railLine(style: Styler, text?: string): string {
  return text === undefined ? style.dim(GLYPH.pipe) : `${style.dim(GLYPH.pipe)}  ${text}`;
}

/** The keys that apply, then the corner that closes the frame. */
export function footerLines(style: Styler, keys: readonly string[]): string[] {
  return [railLine(style, style.dim(keys.join(` ${GLYPH.sep} `))), style.dim(GLYPH.end)];
}
