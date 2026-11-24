/** A kind with no file-spec schema cannot be published or verified, so it is not one. */
export const KINDS = ["plugin", "skill", "agent"] as const;

export type ArtifactKind = (typeof KINDS)[number];

export function isKind(value: string): value is ArtifactKind {
  return (KINDS as readonly string[]).includes(value);
}

/** The file that makes a directory a skill and holds its front matter. */
export const SKILL_ENTRY = "SKILL.md";

/** An MCP server version's files: the publisher's `server.json`, and the registry's policy. */
export const MCP_SERVER_ENTRY = "server.json";
export const MCP_POLICY_FILE = "policy.json";
/** The `spec._meta` key that carries `policy.json`, reverse-DNS as MCP Registry `_meta` keys are. */
export const MCP_POLICY_META = "sh.aireg/policy";

/** Where a plugin keeps its own manifest, in the order aireg reads them. */
export const PLUGIN_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
] as const;
