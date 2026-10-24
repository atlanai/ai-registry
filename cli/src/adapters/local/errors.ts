import { AdapterError, SpecError } from "#adapter/index.ts";

export const ID = "local";

export function fail(
  failure: "invalid" | "not_found" | "conflict",
  message: string,
  artifact?: string,
  hint?: string,
): AdapterError {
  return new AdapterError(ID, failure, message, { artifact, hint });
}

/**
 * One boundary where a failure becomes an `AdapterError`, so a spec problem
 * reads as this adapter's rather than as an unclassified throw.
 */
export async function translating<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (error instanceof SpecError) {
      throw fail(
        error.missing ? "not_found" : "invalid",
        error.message,
        error.artifact,
        error.hint,
      );
    }
    throw fail("invalid", error instanceof Error ? error.message : String(error));
  }
}
