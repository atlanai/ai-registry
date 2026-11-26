import { defineTarget } from "#core/target/contract.ts";

export const pi = defineTarget({
  id: "pi",
  displayName: "Pi",
  category: "coding-agent",
  roots: { project: ".pi", user: { default: "~/.pi/agent", env: "PI_CODING_AGENT_DIR" } },
  detect: { env: ["PI_CODING_AGENT_DIR"], binary: ["pi"], caller: ["PI_CODING_AGENT"] },
  // It finds a project's `.agents/skills` from any folder up to the repository root, but its
  // `.pi/skills` only in the folder it starts in.
  reads: { skill: ["universal", "pi"] },
  kinds: {
    // Its packages carry extensions, which are code it runs, so a plugin lands as its parts.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    // It expands a variable only in `env` and `headers`, and refuses an SSE server.
    mcp_server: {
      shape: "config",
      file: "mcp.json",
      format: "json",
      at: ["mcpServers", "{name}"],
      codec: { id: "mcp-json", secret: { prefix: "${", suffix: "}", in: ["env", "headers"] } },
      transports: ["stdio", "streamable-http"],
    },
  },
  verified: { command: ["pi", "--version"], range: "1.1.0 || 1.4.0 || 1.5.2" },
  trust: { skill: { run: "/trust", scope: "project" } },
  reload: "Run /reload in Pi, or start a new session, to load the change.",
});
