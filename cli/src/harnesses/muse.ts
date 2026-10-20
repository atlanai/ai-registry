import { defineHarness } from "#core/harness/contract.ts";

export const muse = defineHarness({
  id: "muse",
  displayName: "Muse Code",
  roots: {
    project: ".muse",
    user: { default: "~/.config/muse", env: "XDG_CONFIG_HOME", within: "muse" },
  },
  detect: { binary: ["muse"] },
  reads: { skill: ["agents", "muse", "claude", "codex"] },
  kinds: {
    // Its plugins install through its own commands, into a folder the docs do not name.
    plugin: { shape: "contents" },
    // In a project it reads skills from other tools' folders alone.
    skill: { shape: "directory", subdir: "skills", scope: "user" },
  },
  verified: { command: ["muse", "--version"], range: "1.4.11" },
});
