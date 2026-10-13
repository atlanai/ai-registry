import { defineHarness } from "#core/harness/contract.ts";

export const claude = defineHarness({
  id: "claude",
  displayName: "Claude Code",
  runtime: "claude-code",
  default: true,
  importable: true,
  roots: { project: ".claude", user: { default: "~/.claude", env: "CLAUDE_CONFIG_DIR" } },
  detect: { env: ["CLAUDE_CONFIG_DIR"], binary: ["claude"], caller: ["CLAUDECODE", "CLAUDE_CODE"] },
  kinds: {
    // `plugins/` is Claude's own store and is never scanned; a plugin manifest
    // makes a directory under `skills/` a plugin.
    plugin: {
      shape: "directory",
      subdir: "skills",
      scope: "user",
      manifest: [{ path: ".claude-plugin/plugin.json" }],
    },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
});
