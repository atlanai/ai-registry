import { isLocalPath } from "./paths.ts";
import { sanitizeName } from "./text.ts";

// How a registry's address reads to a person: its host, and the name it suggests.

/** `user@host:path`, the form git takes a remote in without a scheme. */
export const SCP_LOCATION = /^(?:([\w.-]+)@)?([\w.-]+):(?!\/)(.+)$/;

/**
 * `acme/platform` is a registry and a namespace, never a repository: a source
 * spells out its host, so the two can not be mistaken for each other.
 */
export function namesHost(input: string): boolean {
  if (isLocalPath(input) || input.includes("://") || SCP_LOCATION.test(input)) return true;
  return (input.split("/")[0] ?? "").includes(".");
}

/**
 * The last path segment is what a person would have typed, so `acme/kit` and
 * `/src/kit` both become `kit`. A bare origin has none, so `fallback` names it.
 */
export function registryNameFromLocation(location: string, fallback: string): string {
  let path = location;
  try {
    path = new URL(location).pathname;
  } catch {
    // Not a URL, so the whole address is the path.
  }
  // A Windows folder path separates with backslashes.
  const last = path
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/, "")
    .split(/[/\\:]/)
    .at(-1)
    ?.split("@")[0];
  return last === undefined || last === "" ? fallback : sanitizeName(last);
}
