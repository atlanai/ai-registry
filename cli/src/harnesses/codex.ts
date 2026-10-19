import { defineHarness } from "#core/harness/contract.ts";

const PLUGIN_BODY = {
  interface: { displayName: "{name}", shortDescription: "{description}" },
  skills: "./skills/",
};

export const codex = defineHarness({
  id: "codex",
  displayName: "Codex",
  default: true,
  importable: true,
  roots: { project: ".codex", user: { default: "~/.codex", env: "CODEX_HOME" } },
  detect: {
    env: ["CODEX_HOME"],
    binary: ["codex"],
    caller: ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"],
  },
  reads: { skill: ["agents"] },
  kinds: {
    // Codex loads `plugin@marketplace` from its cache, only from the user
    // installation, and will not load a linked plugin directory.
    plugin: {
      shape: "directory",
      subdir: "plugins/cache/{source}/{name}/local",
      scope: "user",
      place: "fan",
      manifest: [
        { path: ".codex-plugin/plugin.json", body: PLUGIN_BODY },
        // The portable manifest, which Codex reads only under this schema.
        {
          path: "plugin.json",
          body: {
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            ...PLUGIN_BODY,
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
        },
        // A plugin loads only through a marketplace, so each source is one,
        // pointed at its own cache.
        {
          file: "config.toml",
          format: "toml",
          at: ["marketplaces", "{source}"],
          value: { source_type: "local", source: "{root}/plugins/cache/{source}" },
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
    skill: { shape: "directory", subdir: "skills" },
    // Codex reads an agent only as TOML, and refuses to run a linked one.
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
});
