import { defineTarget } from "#core/target/contract.ts";

export const opencode = defineTarget({
  id: "opencode",
  displayName: "OpenCode",
  category: "coding-agent",
  roots: {
    project: ".opencode",
    user: { default: "~/.config/opencode", env: "XDG_CONFIG_HOME", within: "opencode" },
  },
  detect: { env: ["OPENCODE_CONFIG_DIR"], binary: ["opencode"], caller: ["OPENCODE"] },
  reads: { skill: ["universal", "opencode", "claude-code"] },
  kinds: {
    // Its plugins are code it runs, which a registry's plugin never is.
    plugin: { shape: "contents" },
    // It reads no key that keeps a skill for a person, so one that sets it is left out.
    skill: { shape: "directory", subdir: "skills", keys: { "disable-model-invocation": false } },
    // A key another coding agent reads, such as a `color` name or a `tools` list, makes its
    // whole configuration invalid, so an agent keeps only what every coding agent means alike.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".md",
      codec: { id: "frontmatter-strict", keep: ["description"] },
    },
  },
  verified: { command: ["opencode", "--version"], range: "1.19.0" },
});
