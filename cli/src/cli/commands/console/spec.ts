import type { CommandSpec } from "#cli/commands/command.ts";

export const CONSOLE_COMMAND = {
  name: "console",
  summary: "Open a full-screen view of installed artifacts, jobs and registries",
  group: "Check",
  usage: ["aireg console [--account <account>]"],
  examples: [
    { command: "aireg console", what: "open the console" },
    { command: "aireg console --json", what: "the same state, as data" },
  ],
  docs: "console",
  options: [{ flag: "--account", value: "<account>", describe: "The account to open on" }],
} satisfies CommandSpec;
