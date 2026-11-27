import { defineTarget } from "#core/target/contract.ts";

export const grok = defineTarget({
  id: "grok",
  displayName: "Grok Build",
  category: "coding-agent",
  roots: { project: ".grok", user: { default: "~/.grok", env: "GROK_HOME" } },
  detect: { env: ["GROK_HOME"], binary: ["grok"], caller: ["GROK_SESSION_ID"] },
  reads: { skill: ["grok", "universal"] },
  kinds: {
    // Grok starts a user plugin disabled until its config names it, so a plugin lands as its parts.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
    mcp_server: {
      shape: "config",
      file: "config.toml",
      format: "toml",
      at: ["mcp_servers", "{name}"],
      codec: { id: "mcp-json", secret: { prefix: "${", suffix: "}" } },
      transports: ["stdio", "streamable-http"],
    },
  },
  verified: { command: ["grok", "--version"], range: "1.0.5" },
  trust: { skill: { run: "grok --trust", scope: "project" } },
  reload: "Start a new Grok Build session to load the change.",
});
