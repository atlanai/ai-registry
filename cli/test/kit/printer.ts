import { Printer, type PrinterOptions } from "#core/term/printer.ts";

export interface CaptureOptions extends Omit<PrinterOptions, "out" | "err"> {
  /** Collects standard output chunk by chunk. */
  printed?: string[];
  /** Collects standard error; passing `printed` here too keeps the two interleaved. */
  errors?: string[];
}

/** A printer that writes to arrays rather than the terminal, uncoloured unless asked. */
export function capturedPrinter(options: CaptureOptions = {}): {
  printer: Printer;
  printed: string[];
  errors: string[];
} {
  const { printed = [], errors = [], ...rest } = options;
  const printer = new Printer({
    color: "never",
    ...rest,
    out: { write: (chunk: string) => printed.push(chunk) > 0, isTTY: false },
    err: { write: (chunk: string) => errors.push(chunk) > 0, isTTY: false },
  });
  return { printer, printed, errors };
}
