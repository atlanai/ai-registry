import { adapterOf, adapterProblem } from "#adapter/errors.ts";
import { type AdapterError, SpecError } from "#adapter/index.ts";
import { AiregError, ErrorCode, type ExitCode, exitCodeFor } from "#core/errors.ts";
import type { Printer } from "#core/term/printer.ts";

interface Classified {
  code: ErrorCode;
  message: string;
  hint: string | undefined;
  adapter: string | undefined;
  trace: string | undefined;
}

/** TTY, `--json` and the exit status for one failure, so they cannot drift apart. */
export function reportError(printer: Printer, error: unknown): ExitCode {
  const { code, message, hint, adapter, trace } = classify(error);
  if (printer.format === "json") {
    printer.json({
      ok: false,
      error: {
        code,
        message,
        ...(hint === undefined ? {} : { hint }),
        ...(adapter === undefined ? {} : { adapter }),
        ...(trace === undefined ? {} : { trace }),
      },
    });
  } else {
    printer.error(message);
    if (code !== ErrorCode.Error) printer.field("code", code);
    if (hint !== undefined) printer.hint(hint);
    if (trace !== undefined) printer.field("trace", trace);
  }
  return exitCodeFor(code);
}

function classify(error: unknown): Classified {
  const adapter = adapterOf(error);
  // A wrapper that names no code of its own keeps the adapter's, so not_found survives.
  const own = ownCode(error);
  const code = own === ErrorCode.Error && adapter !== undefined ? adapterCode(adapter) : own;
  // A wrapper with no hint of its own keeps the adapter's, which says what to do.
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    hint:
      (error instanceof AiregError || error instanceof SpecError ? error.hint : undefined) ??
      adapter?.hint ??
      carried(error).hint,
    adapter: adapter?.adapter,
    trace: adapter === undefined ? undefined : adapterProblem(adapter).trace_id,
  };
}

/** The code a failure names itself: ours, or a registry document the file spec refuses. */
function ownCode(error: unknown): ErrorCode {
  if (error instanceof AiregError) return error.code;
  if (error instanceof SpecError)
    return error.code === "not_found" ? ErrorCode.NotFound : ErrorCode.Invalid;
  return carried(error).code ?? ErrorCode.Error;
}

const CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

/** The daemon sends a failure it classified with its code and hint, which survive the socket. */
function carried(error: unknown): { code?: ErrorCode; hint?: string } {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (typeof data !== "object" || data === null) return {};
  const { code, hint } = data as { code?: unknown; hint?: unknown };
  return {
    ...(typeof code === "string" && CODES.has(code) ? { code: code as ErrorCode } : {}),
    ...(typeof hint === "string" ? { hint } : {}),
  };
}

/** An adapter's failure is already one of our codes, save content that failed its digest or an address typed wrong. */
function adapterCode(adapter: AdapterError): ErrorCode {
  const { code } = adapterProblem(adapter);
  if (code === "DIGEST_MISMATCH") return ErrorCode.Integrity;
  return code === "USAGE" ? ErrorCode.Usage : adapter.failure;
}
