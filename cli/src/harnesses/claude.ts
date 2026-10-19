import { defineHarness } from "#core/harness/contract.ts";

export const claude = defineHarness({
  id: "claude",
  displayName: "Claude Code",
  default: true,
  importable: true,
  roots: { project: ".claude", user: { default: "~/.claude", env: "CLAUDE_CONFIG_DIR" } },
  detect: { env: ["CLAUDE_CONFIG_DIR"], binary: ["claude"], caller: ["CLAUDECODE", "CLAUDE_CODE"] },
  kinds: {
    // `plugins/` is Claude's own store and is never scanned; a plugin manifest
    // makes a directory under `skills/` a plugin, in a project's as in the user's.
    plugin: {
      shape: "directory",
      subdir: "skills",
      manifest: [{ path: ".claude-plugin/plugin.json" }],
    },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
});
