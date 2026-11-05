import { AdapterError, type Failure, SpecError } from "#adapter/index.ts";

export const ID = "git";

/** Git registries take no token from aireg: git brings its own credentials. */
export const CREDENTIALS =
  "Sign in with git: run `gh auth login`, or set up a git credential helper.";

export function fail(
  failure: Extract<Failure, "invalid" | "not_found">,
  message: string,
  options: { artifact?: string | undefined; hint?: string | undefined } = {},
): AdapterError {
  return new AdapterError(ID, failure, message, options);
}

/** The file spec speaks its own failures; the client only ever sees the contract's. */
export async function translating<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof SpecError) {
      throw new AdapterError(ID, cause.missing ? "not_found" : "invalid", cause.message, {
        cause,
        hint: cause.hint,
        artifact: cause.artifact,
      });
    }
    throw cause;
  }
}
