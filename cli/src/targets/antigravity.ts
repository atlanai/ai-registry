import { defineTarget } from "#core/target/contract.ts";

export const antigravity = defineTarget({
  id: "antigravity",
  displayName: "Google Antigravity",
  category: "coding-agent",
  roots: { project: ".agents", user: { default: "~/.gemini/config" } },
  // `.agents` is several tools' folder, so only Antigravity's own folders prove it is installed.
  detect: {
    binary: ["agy"],
    paths: ["~/.gemini/antigravity", "~/.gemini/antigravity-ide"],
    projectRoot: false,
  },
  kinds: {
    plugin: { shape: "contents" },
    // Some releases ignore a linked skill folder.
    skill: {
      shape: "directory",
      subdir: "skills",
      place: "copy",
      keys: { "disable-model-invocation": false },
    },
    // A project's `.agents/agents` holds other tools' agents, whose `tools` and `model` it rejects.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".md",
      scope: "user",
      codec: { id: "frontmatter-strict", keep: ["name", "description"] },
    },
    // It documents no way to read a secret, so a server that needs one is left out.
    mcp_server: {
      shape: "config",
      // Its CLI reads MCP servers only from the user's file, not a project's `.agents/`.
      scope: "user",
      file: "mcp_config.json",
      format: "json",
      at: ["mcpServers", "{name}"],
      codec: {
        id: "mcp-json",
        url: { "streamable-http": "serverUrl" },
        tools: { allow: ["enabledTools"], deny: ["disabledTools"] },
      },
      transports: ["stdio", "streamable-http"],
    },
  },
  verified: { command: ["agy", "--version"], range: "1.4.5" },
  reload:
    "Start a new conversation in Antigravity, or run `/skills reload` in its CLI, to load the change.",
});
