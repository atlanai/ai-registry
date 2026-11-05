import { AdapterError, type Failure } from "#adapter/index.ts";

export const ID = "well-known";

export function fail(
  failure: Extract<Failure, "invalid" | "not_found" | "unavailable">,
  message: string,
  options: { artifact?: string | undefined; hint?: string | undefined } = {},
): AdapterError {
  return new AdapterError(ID, failure, message, options);
}
