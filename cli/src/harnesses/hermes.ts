import { defineHarness } from "#core/harness/contract.ts";

export const hermes = defineHarness({
  id: "hermes",
  displayName: "Hermes Agent",
  kind: "personal",
  roots: { project: ".hermes", user: { default: "~/.hermes", env: "HERMES_HOME" } },
  detect: { env: ["HERMES_HOME"], binary: ["hermes"], caller: ["HERMES_SESSION_ID"] },
  instances: { root: "~/.hermes/profiles/{profile}" },
  trust: { skill: { run: "hermes skills trust", scope: "project" } },
  kinds: {
    plugin: { shape: "contents" },
    // It edits any skill it finds, wherever it is, so each is a copy, whose edits `aireg status` shows.
    skill: { shape: "directory", subdir: "skills", place: "copy" },
  },
  verified: { command: ["hermes", "--version"], range: "0.21.6" },
});
