import { defineTarget } from "#core/target/contract.ts";

// Devin Desktop, formerly Windsurf, runs the Devin CLI as its agent, so both read these folders.
export const devin = defineTarget({
  id: "devin",
  displayName: "Devin",
  category: "coding-agent",
  roots: {
    project: ".devin",
    user: {
      default: "~/.config/devin",
      env: "XDG_CONFIG_HOME",
      within: "devin",
      windows: { default: "~/AppData/Roaming/devin", env: "APPDATA", within: "devin" },
    },
  },
  // `~/.codeium/windsurf` is left out: other skill installers create it too.
  detect: { binary: ["devin", "devin-desktop"], paths: ["~/.devin"] },
  reads: { skill: ["devin", "universal"] },
  kinds: {
    // Its plugins install only through `devin plugins install`, signed in.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    // It checks `model` and `tools` against its own names only when the agent runs, so an
    // agent keeps what every coding agent means alike.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".md",
      codec: { id: "frontmatter-strict", keep: ["name", "description"] },
    },
    mcp_server: {
      shape: "config",
      file: "mcp_config.json",
      format: "json",
      at: ["mcpServers", "{name}"],
      codec: {
        id: "mcp-json",
        secret: { prefix: "${env:", suffix: "}" },
        type: { stdio: "stdio", "streamable-http": "http", sse: "sse" },
        tools: { deny: ["disabledTools"] },
      },
      transports: ["stdio", "streamable-http", "sse"],
    },
  },
  verified: { command: ["devin", "--version"], range: "3000.14.30833 || 3000.15.14" },
  reload: "Start a new Devin session to load the change.",
});
