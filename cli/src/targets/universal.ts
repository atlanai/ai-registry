import { defineTarget } from "#core/target/contract.ts";

// A folder several tools read rather than a tool: project `.agents` pairs with
// `~/.agents`, where most tools read skills from.
export const universal = defineTarget({
  id: "universal",
  aliases: ["agents"],
  displayName: "Shared .agents folder",
  importable: true,
  category: "shared-folder",
  roots: { project: ".agents", user: { default: "~/.agents" } },
  detect: "never",
  kinds: {
    // No plugin container of its own, so a namespace lands as its parts.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
});
