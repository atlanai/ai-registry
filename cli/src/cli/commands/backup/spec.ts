import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const BACKUP_COMMAND: CommandSpec = {
  name: "backup",
  summary: "See or restore files of yours that aireg moved aside",
  group: "Maintain",
  usage: ["aireg backup [<action>] [options]"],
  examples: [
    { command: "aireg backup list -g", what: "see what aireg moved out of your tools' folders" },
    { command: "aireg backup restore -g", what: "choose a run and put what it moved back" },
  ],
  docs: "backup",
  actions: [
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the runs that moved files aside, newest first",
      usage: ["aireg backup list [options]"],
      options: [USER],
      maxArguments: 0,
    },
    {
      name: "restore",
      summary: "Put what a run moved aside back where it was",
      usage: ["aireg backup restore [<stamp>] [options]"],
      options: [USER],
      maxArguments: 1,
    },
  ],
};
