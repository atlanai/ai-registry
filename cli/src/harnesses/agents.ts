import { defineHarness } from "#core/harness/contract.ts";

// A folder several tools read rather than a tool: project `.agents` pairs with
// `~/.agents`, where most tools read skills from.
export const agents = defineHarness({
  id: "agents",
  displayName: "Shared .agents folder",
  importable: true,
  kind: "shared",
  roots: { project: ".agents", user: { default: "~/.agents" } },
  detect: "never",
  kinds: {
    // No plugin container of its own, so a namespace lands as its parts.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
});
