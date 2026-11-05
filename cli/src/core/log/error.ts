import type { SerializedError } from "./model.ts";

/** A cause chain can be cyclic, and nothing in the language stops it. */
const MAX_DEPTH = 5;

export function serializeError(error: unknown, depth = MAX_DEPTH): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: typeof error === "string" ? error : String(error) };
  }

  const serialized: SerializedError = { name: error.name, message: error.message };
  const code = codeOf(error);
  if (code !== undefined) serialized.code = code;
  if (!classified(error, code) && error.stack !== undefined) serialized.stack = error.stack;
  if (depth > 0 && error.cause !== undefined && error.cause !== null) {
    serialized.cause = serializeError(error.cause, depth - 1);
  }
  return serialized;
}

function codeOf(error: Error): string | undefined {
  for (const key of ["failure", "code"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/**
 * A stack on every expected failure buries the one unexpected throw that is the bug. An
 * error that names its own code is expected; Node's system errors name only the call.
 */
function classified(error: Error, code: string | undefined): boolean {
  if (code === undefined) return false;
  return !("syscall" in error) && !code.startsWith("ERR_");
}
