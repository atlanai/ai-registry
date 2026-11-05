import type { Fields } from "#adapter/fields.ts";
import { quoted } from "#adapter/text.ts";
import { namesOf, unknownKeysProblem } from "#core/fields.ts";
import { ManifestError } from "./errors.ts";

export function optionalString(root: Record<string, unknown>, key: string): string | undefined {
  const value = root[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManifestError(`\`${key}:\` must be text.`);
  return value;
}

/** A key nobody reads is a typo, and ignoring it hides what the file does. */
export function onlyKnown(record: Fields, known: readonly string[], where: string): void {
  const problem = unknownKeysProblem(record, known, where);
  if (problem !== undefined) throw new ManifestError(problem);
}

/** Far past any real address, and short enough that no parse of one can stall a run. */
const MAX_LOCATION = 2048;

export function address(alias: string, location: string): string {
  if (location.length > MAX_LOCATION) {
    throw new ManifestError(`Registry ${quoted(alias)} has an address too long to be one.`);
  }
  return location;
}

export function stringList(raw: unknown, ref: string, key: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const names = namesOf(raw);
  if (names === undefined) {
    throw new ManifestError(`\`${key}:\` of artifact ${quoted(ref)} must be a list of names.`);
  }
  return names;
}
