import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const LIST_COMMAND: CommandSpec = {
  name: "list",
  aliases: ["ls"],
  summary: "List what is installed",
  group: "Check",
  usage: ["aireg list [-g]", "aireg list <name> [-g]"],
  examples: [
    { command: "aireg list", what: "what this project installs" },
    { command: "aireg list engineering/pr-review", what: "where one came from" },
  ],
  docs: "list",
  options: [USER],
  maxArguments: 1,
};
