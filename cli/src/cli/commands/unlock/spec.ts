import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const UNLOCK_COMMAND: CommandSpec = {
  name: "unlock",
  summary: "Show or clear a stuck write lock",
  group: "Maintain",
  usage: ["aireg unlock [-g]", "aireg unlock [-g] <id>"],
  examples: [{ command: "aireg unlock", what: "see what holds this project's write lock" }],
  docs: "unlock",
  options: [USER],
  maxArguments: 1,
};
