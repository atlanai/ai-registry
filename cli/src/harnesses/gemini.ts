import { defineHarness } from "#core/harness/contract.ts";

export const gemini = defineHarness({
  id: "gemini",
  displayName: "Gemini CLI",
  roots: {
    project: ".gemini",
    user: { default: "~/.gemini", env: "GEMINI_CLI_HOME", within: ".gemini" },
  },
  detect: { env: ["GEMINI_CLI_HOME"], binary: ["gemini"], caller: ["GEMINI_CLI"] },
  // Its own folder first: its user `.agents` moves with GEMINI_CLI_HOME, the shared one does not.
  reads: { skill: ["gemini", "agents"] },
  kinds: {
    // An extension would also carry its agents as written, beside the ones the codec writes.
    plugin: { shape: "contents" },
    // It reads no key that keeps a skill for a person, so one that sets it is left out.
    skill: { shape: "directory", subdir: "skills", keys: { "disable-model-invocation": false } },
    // It refuses an agent with a key it does not know, and skips a linked one.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".md",
      codec: {
        id: "frontmatter-strict",
        keep: [
          "kind",
          "name",
          "description",
          "display_name",
          "tools",
          "mcp_servers",
          "model",
          "temperature",
          "max_turns",
          "timeout_mins",
        ],
      },
    },
  },
  verified: { command: ["gemini", "--version"], range: "0.63.0" },
  // It loads a project's skills and agents only in a folder you trusted.
  trust: {
    skill: { run: "/permissions trust", scope: "project" },
    agent: { run: "/permissions trust", scope: "project" },
  },
  reload:
    "Run `/skills reload` and `/agents reload` in Gemini CLI, or start a new session, to load the change.",
});
