import { defineTarget } from "#core/target/contract.ts";

export const windsurf = defineTarget({
  id: "windsurf",
  displayName: "Windsurf",
  category: "coding-agent",
  roots: { project: ".windsurf", user: { default: "~/.codeium/windsurf" } },
  detect: { binary: ["windsurf"] },
  reads: { skill: ["windsurf", "universal"] },
  kinds: {
    // Windsurf has no native plugin format, so a plugin lands as its skills.
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
  },
  reload: "Restart Windsurf, or run Developer: Reload Window, to load the change.",
});
