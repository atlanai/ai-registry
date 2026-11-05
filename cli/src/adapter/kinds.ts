/** A kind with no file-spec schema cannot be published or verified, so it is not one. */
export const KINDS = ["plugin", "skill", "agent"] as const;

/** One of `KINDS`. */
export type ArtifactKind = (typeof KINDS)[number];

/** Whether a string from outside, such as a path segment, names a kind. */
export function isKind(value: string): value is ArtifactKind {
  return (KINDS as readonly string[]).includes(value);
}

/** The file that makes a directory a skill and holds its front matter. */
export const SKILL_ENTRY = "SKILL.md";

/** Where a plugin keeps its own manifest, in the order aireg reads them. */
export const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
] as const;
