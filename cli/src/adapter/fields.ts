/** A parsed document or message, read field by field because none of it is trusted yet. */
export type Fields = Record<string, unknown>;

/** A JSON object or YAML mapping: not null, and not a list. */
export function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with more than whitespace in it, as written, or undefined. */
export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A string with more than whitespace in it, trimmed, or undefined. */
export function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
