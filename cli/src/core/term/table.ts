import { displayWidth } from "./format.ts";
import type { Printer, Styler } from "./printer.ts";

export interface Column<R> {
  header: string;
  /** May carry styling; widths are measured without it. */
  value: (row: R) => string;
  align?: "left" | "right";
  /** Dropped when no row has a value, so a column of blanks never prints. */
  optional?: boolean;
}

/** The aligned lines, for a caller that places them itself, such as a prompt frame. */
export function tableLines<R>(
  style: Styler,
  columns: readonly Column<R>[],
  rows: readonly R[],
  options: TableOptions = {},
): string[] {
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const shown = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => !column.optional || cells.some((row) => row[index] !== ""));

  const widths = shown.map(({ column, index }) =>
    Math.max(
      options.header === false ? 0 : displayWidth(column.header),
      ...cells.map((row) => displayWidth(row[index] ?? "")),
    ),
  );
  const gutter = " ".repeat(options.indent ?? 2);
  const line = (values: readonly string[]): string =>
    `${gutter}${values.map((value, at) => padCell(value, widths[at] ?? 0, shown[at]?.column.align)).join("  ")}`.trimEnd();

  const out = cells.map((row) => line(shown.map(({ index }) => row[index] ?? "")));
  if (options.header !== false)
    out.unshift(style.dim(line(shown.map(({ column }) => column.header))));
  return out;
}

interface TableOptions {
  header?: boolean;
  /** Leading spaces; a prompt frame supplies its own gutter. */
  indent?: number;
}

function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
  const gap = " ".repeat(Math.max(0, width - displayWidth(text)));
  return align === "right" ? gap + text : text + gap;
}

/** Every listing prints through here, so columns line up the same way everywhere. */
export function table<R>(
  printer: Printer,
  columns: readonly Column<R>[],
  rows: readonly R[],
  options: TableOptions = {},
): void {
  for (const line of tableLines(printer.style, columns, rows, options)) printer.info(line);
}

/** A label and value per line, for one thing described in detail. */
export function fields(printer: Printer, rows: readonly (readonly [string, string])[]): void {
  table(
    printer,
    [
      { header: "", value: ([label]) => printer.style.dim(label) },
      { header: "", value: ([, value]) => value },
    ],
    rows,
    { header: false },
  );
}
