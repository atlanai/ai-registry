import { defineTarget } from "#core/target/contract.ts";

export const hermesAgent = defineTarget({
  id: "hermes-agent",
  displayName: "Hermes Agent",
  category: "personal-agent",
  // It reads `~/.agents/skills` only once its config lists the folder, so yours go to its own.
  roots: { project: ".agents", user: { default: "~/.hermes", env: "HERMES_HOME" } },
  detect: {
    env: ["HERMES_HOME"],
    binary: ["hermes"],
    projectRoot: false,
    caller: ["HERMES_AGENT"],
  },
  kinds: {
    // Its plugins are Python code it runs, so a plugin lands as its parts.
    plugin: { shape: "contents" },
    // Its bundled skills sit in category folders, and it loads neither of two sharing a name.
    skill: {
      shape: "directory",
      subdir: "skills",
      depth: 6,
      keys: { "disable-model-invocation": false },
    },
  },
  verified: { command: ["hermes", "--version"], range: "0.23.0" },
  trust: { skill: { run: "hermes skills trust", scope: "project" } },
  reload:
    "Hermes Agent sees the change at your next message; run /reload-skills to refresh its slash commands.",
});
