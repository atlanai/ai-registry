import type { CommandSpec } from "#cli/commands/command.ts";
import { ALL } from "#cli/options/flags.ts";

export const TARGETS_COMMAND: CommandSpec = {
  name: "targets",
  formerly: ["harnesses"],
  summary: "List the targets aireg can install into, and which this machine has",
  group: "Check",
  usage: ["aireg targets [--all]", "aireg targets show <id>", "aireg targets check <file>"],
  examples: [{ command: "aireg targets", what: "which coding agents this machine has" }],
  docs: "targets",
  options: [{ ...ALL, describe: "List every target aireg supports, not only those found" }],
  actions: [
    {
      name: "show",
      summary: "Print where a target takes each kind, as aireg resolved it",
      usage: ["aireg targets show <id>"],
      maxArguments: 1,
      examples: [{ command: "aireg targets show codex", what: "where Codex gets each kind" }],
    },
    {
      name: "check",
      summary: "Check a target file before you use it",
      usage: ["aireg targets check <file>"],
      maxArguments: 1,
      examples: [{ command: "aireg targets check tool.json", what: "is this file usable?" }],
    },
  ],
};
