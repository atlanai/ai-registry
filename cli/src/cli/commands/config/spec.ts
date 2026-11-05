import type { CommandSpec } from "#cli/commands/command.ts";

export const CONFIG_COMMAND: CommandSpec = {
  name: "config",
  summary: "Read and write aireg's own settings",
  group: "Maintain",
  usage: ["aireg config [<action>]"],
  examples: [
    {
      command: "aireg config set defaults.namespace acme/engineering",
      what: "publish there by default",
    },
    { command: "aireg config get defaults.namespace", what: "read a setting in a script" },
  ],
  docs: "config",
  actions: [
    {
      name: "list",
      aliases: ["ls"],
      summary: "List every setting",
      usage: ["aireg config list"],
      maxArguments: 0,
    },
    {
      name: "get",
      summary: "Print one setting",
      usage: ["aireg config get <key>"],
      maxArguments: 1,
    },
    {
      name: "set",
      summary: "Change one setting",
      usage: ["aireg config set <key> <value>"],
      maxArguments: 2,
    },
    {
      name: "unset",
      summary: "Put one setting back to its default",
      usage: ["aireg config unset <key>"],
      maxArguments: 1,
    },
    {
      name: "path",
      summary: "Print where the settings file is",
      usage: ["aireg config path"],
      maxArguments: 0,
    },
  ],
};
