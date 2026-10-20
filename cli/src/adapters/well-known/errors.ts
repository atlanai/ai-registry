import { AdapterError } from "#adapter/index.ts";

/** The adapter's id, under which every failure it reports is filed. */
export const ID = "well-known";

export function fail(
  failure: "invalid" | "not_found" | "unavailable",
  message: string,
  hint?: string,
): AdapterError {
  return new AdapterError(ID, failure, message, { hint });
}
