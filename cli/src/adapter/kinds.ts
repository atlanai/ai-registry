/** A kind with no file-spec schema cannot be published or verified, so it is not one. */
export const KINDS = ["plugin", "skill", "agent", "knowledge"] as const;

/** One of `KINDS`. */
export type ArtifactKind = (typeof KINDS)[number];

/** Whether a string from outside, such as a path segment, names a kind. */
export function isKind(value: string): value is ArtifactKind {
  return (KINDS as readonly string[]).includes(value);
}
