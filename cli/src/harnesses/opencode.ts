import { defineHarness } from "#core/harness/contract.ts";

export const opencode = defineHarness({
  id: "opencode",
  displayName: "OpenCode",
  roots: {
    project: ".opencode",
    user: { default: "~/.config/opencode", env: "XDG_CONFIG_HOME", within: "opencode" },
  },
  detect: { env: ["OPENCODE_CONFIG_DIR"], binary: ["opencode"], caller: ["OPENCODE"] },
  reads: { skill: ["agents", "opencode", "claude"] },
  kinds: {
    // Its plugins are code it runs, which a registry's plugin never is.
    plugin: { shape: "contents" },
    // It reads no key that keeps a skill for a person, so one that sets it is left out.
    skill: { shape: "directory", subdir: "skills", keys: { "disable-model-invocation": false } },
    // A key of another harness's, such as a `color` name or a `tools` list, makes its whole
    // configuration invalid, so an agent keeps only what every harness means alike.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".md",
      codec: { id: "frontmatter-strict", keep: ["description"] },
    },
  },
  verified: { command: ["opencode", "--version"], range: "1.19.0" },
});
