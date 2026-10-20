import { defineHarness } from "#core/harness/contract.ts";

export const openclaw = defineHarness({
  id: "openclaw",
  displayName: "OpenClaw",
  kind: "personal",
  roots: { project: ".openclaw", user: { default: "~/.openclaw", env: "OPENCLAW_STATE_DIR" } },
  // It keeps no folder in a project, so a `.openclaw` one there says nothing.
  detect: {
    env: ["OPENCLAW_STATE_DIR"],
    binary: ["openclaw"],
    projectRoot: false,
    caller: ["OPENCLAW_SHELL", "OPENCLAW_CLI"],
  },
  instances: { root: "~/.openclaw-{profile}" },
  kinds: {
    plugin: { shape: "contents" },
    // It edits a skill when asked to, so each is a copy, whose edits `aireg status` shows.
    skill: { shape: "directory", subdir: "skills", scope: "user", place: "copy" },
  },
  verified: { command: ["openclaw", "--version"], range: "2026.10.1" },
});
