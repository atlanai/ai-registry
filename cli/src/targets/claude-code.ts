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
      // A registry's namespaces load as one plugin, listed in a marketplace of aireg's own: Claude
      // Code runs the entry's command to find it, and serves the folder it prints in place.
      wrapped: {
        subdir: "{tool}/{source}/namespaces/{name}",
        merge: "{tool}/{source}",
        register: [
          {
            file: "{tool}/.claude-plugin/marketplace.json",
            format: "json",
            at: ["plugins"],
            upsert: {
              key: "name",
              item: {
                name: "{source}",
                description: "Artifacts the {source} registry publishes, kept current by {tool}.",
                source: {
                  source: "command",
                  command: "{tool} targets plugin-dir {source}",
                  mode: "link",
                },
              },
            },
            init: { name: "{tool}", owner: { name: "{tool}" }, plugins: [] },
          },
        ],
        setup: {
          add: ["claude", "plugin", "marketplace", "add", "{root}/{tool}"],
          install: ["claude", "plugin", "install", "{source}@{tool}"],
          list: ["claude", "plugin", "list", "--json"],
          id: "{source}@{tool}",
        },
      },
    },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
  // A project's plugins load only once Claude Code trusts the project; skills and agents need no step.
  trust: { plugin: { run: "claude", scope: "project" } },
  verified: { command: ["claude", "--version"], range: "2.1.296" },
});
