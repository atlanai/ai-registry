import { defineTarget } from "#core/target/contract.ts";

export const githubCopilot = defineTarget({
  id: "github-copilot",
  aliases: ["copilot"],
  displayName: "GitHub Copilot",
  category: "coding-agent",
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
    // The project file is Claude Code's `.mcp.json` too, so an entry adds no field Claude's lacks.
    mcp_server: {
      shape: "config",
      file: ".mcp.json",
      anchor: "project",
      userFile: "mcp-config.json",
      format: "json",
      at: ["mcpServers", "{name}"],
      codec: {
        id: "mcp-json",
        secret: { prefix: "${", suffix: "}" },
        type: { stdio: "stdio", "streamable-http": "http", sse: "sse" },
        tools: { allow: ["tools"] },
      },
      transports: ["stdio", "streamable-http", "sse"],
    },
  },
  verified: { command: ["copilot", "--version"], range: "1.0.96 || 1.0.113" },
  reload:
    "Run `/skills reload` in a running Copilot CLI session, and start a new session for changed agents.",
});
