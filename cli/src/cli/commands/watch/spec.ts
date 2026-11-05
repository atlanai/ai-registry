import type { CommandSpec } from "#cli/commands/command.ts";
import { USER } from "#cli/options/flags.ts";

export const WATCH_COMMAND: CommandSpec = {
  name: "watch",
  summary: "Publish a folder's skills and agents whenever they change",
  group: "Share",
  usage: ["aireg watch [<action>] [options]"],
  examples: [
    {
      command: "aireg watch add ~/.claude/skills --to acme/engineering -g",
      what: "publish your skills as you edit them",
    },
    {
      command: "aireg watch remove ~/.claude/skills -g",
      what: "stop, and keep what you installed up to date",
    },
  ],
  docs: "watch",
  actions: [
    {
      name: "add",
      summary: "Publish a folder whenever it changes",
      usage: ["aireg watch add <folder>... --to <registry>/<namespace> [options]"],
      options: [
        {
          flag: "--to",
          value: "<registry>/<namespace>",
          describe: "Where the folder publishes",
        },
        USER,
      ],
    },
    {
      name: "remove",
      aliases: ["rm"],
      summary: "Stop publishing a folder, and keep its scope in sync",
      usage: ["aireg watch remove <folder>... [options]"],
      options: [USER],
    },
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the folders published as they change",
      usage: ["aireg watch list"],
      maxArguments: 0,
    },
  ],
};
