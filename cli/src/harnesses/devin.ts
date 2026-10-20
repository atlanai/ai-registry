import { defineHarness } from "#core/harness/contract.ts";

export const devin = defineHarness({
  id: "devin",
  displayName: "Devin",
  roots: {
    project: ".devin",
    user: { default: "~/.config/devin", env: "XDG_CONFIG_HOME", within: "devin" },
  },
  // Devin Desktop keeps its own folder there, where it also ships its legacy commands.
  detect: { binary: ["devin", "devin-desktop"], paths: ["~/.codeium/windsurf"] },
  reads: { skill: ["agents", "devin", "claude"], agent: ["devin", "agents"] },
  kinds: {
    // A plugin of its own loads only through `devin plugins install`, which needs a sign-in.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
  verified: { command: ["devin", "--version"], range: "3000.11.3" },
});
