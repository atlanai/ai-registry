import { defineTarget } from "#core/target/contract.ts";

export const codex = defineTarget({
  id: "codex",
  displayName: "Codex",
  category: "coding-agent",
  default: true,
  importable: true,
  roots: { project: ".codex", user: { default: "~/.codex", env: "CODEX_HOME" } },
  detect: {
    env: ["CODEX_HOME"],
    binary: ["codex"],
    caller: ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"],
  },
  reads: { skill: ["universal"] },
  kinds: {
    // Codex loads `plugin@marketplace` from its cache, only from the user
    // installation, and will not load a linked plugin directory.
    plugin: {
      shape: "directory",
      subdir: "plugins/cache/{source}/{name}/local",
      scope: "user",
      place: "fan",
      // Only this manifest: under a portable root `plugin.json`, Codex skips linked skills.
      manifest: [
        {
          path: ".codex-plugin/plugin.json",
          body: {
            interface: { displayName: "{name}", shortDescription: "{description}" },
            skills: "./skills/",
          },
        },
      ],
      register: [
        {
          file: "config.toml",
          format: "toml",
          at: ["plugins", "{name}@{source}"],
          value: { enabled: true },
          off: { enabled: false },
          init: {},
        },
        // A plugin loads only through a marketplace, so each source is one,
        // pointed at its own cache.
        {
          file: "config.toml",
          format: "toml",
          at: ["marketplaces", "{source}"],
          value: { source_type: "local", source: "{root}/plugins/cache/{source}" },
          init: {},
          conflict: "keep",
          remove: "entry",
        },
        {
          file: "plugins/cache/{source}/.agents/plugins/marketplace.json",
          format: "json",
          at: ["plugins"],
          upsert: {
            key: "name",
            item: { name: "{name}", source: { path: "./{name}/local", source: "local" } },
          },
          init: { name: "{source}", plugins: [] },
        },
      ],
    },
    // What its plugins carry; outside a plugin Codex reads skills from `.agents/skills`.
    skill: {
      shape: "directory",
      subdir: "skills",
      // Codex reads this policy, not the front-matter key, to wait for a person.
      keys: {
        "disable-model-invocation": {
          path: "agents/openai.yaml",
          body: { policy: { allow_implicit_invocation: false } },
        },
      },
    },
    // Codex reads an agent only as TOML.
    agent: {
      shape: "file",
      subdir: "agents",
      extension: ".toml",
      codec: {
        id: "frontmatter-toml",
        fields: ["name", "description"],
        body: "developer_instructions",
      },
    },
  },
  verified: { command: ["codex", "--version"], range: "0.162.1" },
  // A project's `.codex` folder, agents included, loads only once Codex trusts the project.
  trust: { agent: { run: "codex", scope: "project" } },
});
