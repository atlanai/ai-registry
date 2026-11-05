import type { CommandSpec } from "#cli/commands/command.ts";
import { ALL, DRY_RUN, FORCE, FROZEN, SELECT, USER } from "#cli/options/flags.ts";

export const REMOVE_COMMAND: CommandSpec = {
  name: "remove",
  aliases: ["rm"],
  summary: "Uninstall artifacts",
  group: "Install",
  usage: ["aireg remove <name>... [options]", "aireg remove --all [options]"],
  examples: [
    { command: "aireg remove pr-review", what: "one artifact" },
    { command: "aireg remove -g --all", what: "everything in your user scope" },
  ],
  docs: "remove",
  options: [SELECT, ALL, USER, DRY_RUN, FROZEN, FORCE],
};
