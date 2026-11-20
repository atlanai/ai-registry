import { defineTarget } from "#core/target/contract.ts";

export const hermesAgent = defineTarget({
  id: "hermes-agent",
  displayName: "Hermes Agent",
  category: "personal-agent",
  // A project's skills come from its shared `.agents/skills`; your own from `~/.hermes/skills`
  // alone, since it reads `~/.agents/skills` only once its config lists the folder.
  roots: { project: ".agents", user: { default: "~/.hermes", env: "HERMES_HOME" } },
  // `.agents` is several tools' folder, so finding it proves nothing.
  detect: {
    env: ["HERMES_HOME"],
    binary: ["hermes"],
    projectRoot: false,
    caller: ["HERMES_AGENT"],
  },
  kinds: {
    // Its plugins are Python it runs, which a registry's plugin never is.
    plugin: { shape: "contents" },
    // Linked, so its tools, which cannot find a skill in a linked folder, never edit one.
    // It reads no key that keeps a skill for a person, so one that sets it is left out.
    // It finds skills at any depth, its bundled ones in category folders, and loads neither of two
    // sharing a name; 6 is as deep as other targets look.
    skill: {
      shape: "directory",
      subdir: "skills",
      depth: 6,
      keys: { "disable-model-invocation": false },
    },
  },
  verified: { command: ["hermes", "--version"], range: "0.23.0" },
  // It loads a project's skills only once you trust the repository.
  trust: { skill: { run: "hermes skills trust", scope: "project" } },
  reload:
    "Hermes Agent sees the change at your next message; run /reload-skills to refresh its slash commands.",
});
