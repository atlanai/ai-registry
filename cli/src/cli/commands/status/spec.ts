import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const STATUS_COMMAND: CommandSpec = {
  name: "status",
  summary: "Check installed artifacts against the lockfile, and list the ones nothing manages",
  group: "Check",
  usage: ["aireg status [-g]"],
  examples: [
    { command: "aireg status", what: "check this project" },
    { command: "aireg status -g", what: "check your user scope" },
  ],
  docs: "status",
  options: [USER],
};
