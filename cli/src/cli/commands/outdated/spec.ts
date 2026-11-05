import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const OUTDATED_COMMAND: CommandSpec = {
  name: "outdated",
  summary: "Check each registry for newer versions of what is installed",
  group: "Check",
  usage: ["aireg outdated [-g]"],
  examples: [{ command: "aireg outdated", what: "what has a newer version" }],
  docs: "outdated",
  options: [USER],
};
