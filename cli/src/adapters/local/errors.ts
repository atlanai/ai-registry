import { messageOf } from "#adapter/errors.ts";
import { AdapterError, type Failure, SpecError } from "#adapter/index.ts";

export const ID = "local";

export function fail(
  failure: Extract<Failure, "invalid" | "not_found" | "conflict">,
  message: string,
  options: { artifact?: string | undefined; hint?: string | undefined } = {},
): AdapterError {
  return new AdapterError(ID, failure, message, options);
}

/** A failure as this adapter's, so a spec problem never reads as an unclassified throw. */
export function translated(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof SpecError) {
    return fail(error.missing ? "not_found" : "invalid", error.message, {
      artifact: error.artifact,
      hint: error.hint,
    });
  }
  return fail("invalid", messageOf(error));
}

/** One boundary where a thrown failure becomes an `AdapterError`. */
export async function translating<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translated(error);
  }
}
