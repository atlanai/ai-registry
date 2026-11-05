import type { CommandSpec } from "#cli/commands/command.ts";
import { DRY_RUN, FORCE } from "#cli/options/flags.ts";

export const ADAPTER_COMMAND: CommandSpec = {
  name: "adapter",
  summary: "Install an adapter, or write a new one",
  group: "Maintain",
  usage: ["aireg adapter [<action>] [<id>] [options]"],
  examples: [
    { command: "aireg adapter install acme", what: "read acme registries" },
    { command: "aireg adapter init acme", what: "start an adapter package to develop" },
  ],
  docs: "adapter",
  actions: [
    {
      name: "install",
      summary: "Install an adapter from the release server",
      usage: ["aireg adapter install <id> [options]"],
      maxArguments: 1,
      options: [DRY_RUN, { ...FORCE, describe: "Install it again even if it is installed" }],
    },
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the adapters this machine has",
      usage: ["aireg adapter list"],
      maxArguments: 0,
    },
    {
      name: "remove",
      aliases: ["rm"],
      summary: "Remove an adapter",
      usage: ["aireg adapter remove <id> [--dry-run]"],
      maxArguments: 1,
      options: [DRY_RUN],
    },
    {
      name: "init",
      summary: "Write a new adapter package to start from",
      usage: ["aireg adapter init <id> [options]"],
      maxArguments: 1,
      options: [
        { flag: "--dir", value: "<folder>", describe: "The folder to write the package into" },
        DRY_RUN,
        { ...FORCE, describe: "Overwrite the folder if it exists" },
      ],
    },
  ],
};
