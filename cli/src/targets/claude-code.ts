import { defineTarget } from "#core/target/contract.ts";

export const claudeCode = defineTarget({
  id: "claude-code",
  aliases: ["claude"],
  displayName: "Claude Code",
  category: "coding-agent",
  default: true,
  importable: true,
  roots: { project: ".claude", user: { default: "~/.claude", env: "CLAUDE_CONFIG_DIR" } },
  detect: { env: ["CLAUDE_CONFIG_DIR"], binary: ["claude"], caller: ["CLAUDECODE"] },
  kinds: {
    // `plugins/` is Claude's own store and is never scanned; a plugin manifest
    // makes a directory under `skills/` a plugin.
    plugin: {
      shape: "directory",
      subdir: "skills",
      manifest: [{ path: ".claude-plugin/plugin.json" }],
    },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
  // A project's plugins load only once Claude Code trusts the project; skills and agents need no step.
  trust: { plugin: { run: "claude", scope: "project" } },
  verified: { command: ["claude", "--version"], range: "2.1.296" },
});
