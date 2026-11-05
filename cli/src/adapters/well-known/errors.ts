import { AdapterError } from "#adapter/index.ts";

export const ID = "well-known";

export function fail(
  failure: "invalid" | "not_found" | "unavailable",
  message: string,
  hint?: string,
): AdapterError {
  return new AdapterError(ID, failure, message, { hint });
}
