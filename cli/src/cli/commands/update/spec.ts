import type { CommandSpec } from "#cli/commands/command.ts";
import { COPY, DRY_RUN, FOR, FROZEN, USER } from "#cli/options/flags.ts";

export const UPDATE_COMMAND: CommandSpec = {
  name: "update",
  aliases: ["upgrade"],
  summary: "Take the newest version each registry offers",
  group: "Install",
  usage: ["aireg update [<name> | <registry>]... [options]"],
  examples: [
    { command: "aireg update", what: "the newest of everything" },
    { command: "aireg update acme", what: "only what came from acme" },
  ],
  docs: "update",
  options: [FROZEN, FOR, COPY, DRY_RUN, USER],
};
