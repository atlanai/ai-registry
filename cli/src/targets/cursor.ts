import { defineTarget } from "#core/target/contract.ts";

export const cursor = defineTarget({
  id: "cursor",
  displayName: "Cursor",
  category: "coding-agent",
  roots: { project: ".cursor", user: { default: "~/.cursor" } },
  // `agent`, the CLI's primary name, is too common a name to mean Cursor on its own.
  detect: { binary: ["cursor", "cursor-agent"], caller: ["CURSOR_AGENT"] },
  reads: {
    skill: ["universal", "cursor", "claude-code", "codex"],
    agent: ["cursor", "claude-code"],
  },
  kinds: {
    // It loads a local plugin only as real files, never through a link.
    plugin: {
      shape: "directory",
      subdir: "plugins/local",
      scope: "user",
      place: "copy",
      manifest: [{ path: ".cursor-plugin/plugin.json" }],
    },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
  verified: { command: ["agent", "--version"], range: "2026.10.12-d47ca18" },
  reload: "Restart Cursor, or run Developer: Reload Window, to load the change.",
});
