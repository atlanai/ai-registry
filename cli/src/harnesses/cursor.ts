import { defineHarness } from "#core/harness/contract.ts";

export const cursor = defineHarness({
  id: "cursor",
  displayName: "Cursor",
  roots: { project: ".cursor", user: { default: "~/.cursor" } },
  detect: { binary: ["cursor"], caller: ["CURSOR_AGENT", "CURSOR_TRACE_ID"] },
  reads: { skill: ["agents", "cursor", "claude"], agent: ["cursor", "claude"] },
  kinds: {
    plugin: { shape: "contents" },
    skill: { shape: "directory", subdir: "skills" },
    agent: { shape: "file", subdir: "agents", extension: ".md" },
  },
});
