import { defineHarness } from "#core/harness/contract.ts";

export const copilot = defineHarness({
  id: "copilot",
  displayName: "GitHub Copilot",
  roots: { project: ".github", user: { default: "~/.copilot", env: "COPILOT_HOME" } },
  // Most GitHub repositories hold `.github` for their workflows, so it proves nothing.
  detect: {
    env: ["COPILOT_HOME"],
    binary: ["copilot"],
    projectRoot: false,
    caller: ["COPILOT_CLI"],
  },
  // No `reads`: it skips `~/.agents/skills` once COPILOT_HOME is set, and reads `.claude`
  // only in a project, so its own folders are the ones it reads at every scope.
  kinds: {
    // A plugin of its own loads only once `copilot plugin install` records it.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".agent.md" },
  },
  verified: { command: ["copilot", "--version"], range: "1.0.96" },
  reload:
    "Run `/skills reload` in a running Copilot CLI session, and start a new session for changed agents.",
});
