/** A kind with no file-spec schema cannot be published or verified, so it is not one. */
export const KINDS = ["plugin", "skill", "agent", "semantic_model"] as const;

export type ArtifactKind = (typeof KINDS)[number];

export function isKind(value: string): value is ArtifactKind {
  return (KINDS as readonly string[]).includes(value);
}

/** The file that makes a directory a skill and holds its front matter. */
export const SKILL_ENTRY = "SKILL.md";

/** The Apache Ossie document a semantic model's folder holds: exactly one of the two. */
export const SEMANTIC_MODEL_ENTRIES = ["semantic_model.yaml", "semantic_model.json"] as const;

/** Where a plugin keeps its own manifest, in the order aireg reads them. */
export const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
] as const;
