/** The kinds aireg itself knows, each with a file-spec schema; an adapter may declare more. */
export const KINDS = ["plugin", "skill", "agent"] as const;

export type BuiltinKind = (typeof KINDS)[number];

/** A built-in kind, or another one in the file spec's kind grammar (`isKindSegment`). */
export type ArtifactKind = BuiltinKind | (string & {});

export function isBuiltinKind(value: string): value is BuiltinKind {
  return (KINDS as readonly string[]).includes(value);
}

/** @deprecated Use `isBuiltinKind`, or `isKindSegment` for any kind name. */
export function isKind(value: string): value is BuiltinKind {
  return isBuiltinKind(value);
}

/** The file that makes a directory a skill and holds its front matter. */
export const SKILL_ENTRY = "SKILL.md";

/** Where a plugin keeps its own manifest, in the order aireg reads them. */
export const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
] as const;
