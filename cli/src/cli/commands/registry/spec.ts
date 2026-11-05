import type { CommandSpec } from "#cli/commands/command.ts";
import { AS, DRY_RUN, NAMESPACE, SOURCE, USER } from "#cli/options/flags.ts";

export const REGISTRY_COMMAND: CommandSpec = {
  name: "registry",
  summary: "Declare the registries you install from, or create and check one of your own",
  group: "Set up",
  usage: ["aireg registry [<action>] [options]"],
  examples: [
    {
      command: "aireg registry add github.com/acme/ai-registry --as acme",
      what: "name a registry once",
    },
    { command: "aireg registry validate", what: "check the registry in this folder" },
  ],
  docs: "registry",
  options: [USER],
  actions: [
    {
      name: "add",
      summary: "Declare a registry to install from",
      usage: ["aireg registry add <address> [options]"],
      maxArguments: 1,
      examples: [
        {
          command: "aireg registry add ../acme-registry -g",
          what: "a folder, for you in every project",
        },
      ],
      options: [AS, ...SOURCE, USER, DRY_RUN],
    },
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the registries you have declared",
      usage: ["aireg registry list [-g]"],
      maxArguments: 0,
      options: [USER],
    },
    {
      name: "show",
      summary: "Print what a registry publishes, without installing it",
      usage: ["aireg registry show [<registry>] [options]"],
      maxArguments: 1,
      examples: [{ command: "aireg registry show acme", what: "what acme publishes" }],
      options: [...SOURCE, USER],
    },
    {
      name: "remove",
      aliases: ["rm"],
      summary: "Remove a declared registry",
      usage: ["aireg registry remove <registry> [-g] [--dry-run]"],
      maxArguments: 1,
      options: [USER, DRY_RUN],
    },
    {
      name: "init",
      summary: "Create a registry in a folder",
      usage: ["aireg registry init [<folder>] [options]"],
      maxArguments: 1,
      examples: [
        {
          command: "aireg registry init --name acme --namespace engineering -y",
          what: "a registry with one namespace",
        },
      ],
      options: [
        { flag: "--name", value: "<name>", describe: "The registry's name" },
        {
          flag: "--description",
          value: "<text>",
          describe: "A one-line description of the registry",
        },
        { ...NAMESPACE, multiple: true, describe: "A namespace to create (repeatable)" },
      ],
    },
    {
      name: "index",
      summary: "Index new versions and update index.json",
      usage: ["aireg registry index [<folder>]"],
      maxArguments: 1,
    },
    {
      name: "validate",
      summary: "Check a registry against the file spec",
      usage: ["aireg registry validate [<folder>] [--base <ref>]"],
      maxArguments: 1,
      examples: [
        {
          command: "aireg registry validate --base origin/main",
          what: "check a change before you release it",
        },
      ],
      options: [
        {
          flag: "--base",
          value: "<ref>",
          describe: "A git ref to compare released versions against",
        },
      ],
    },
  ],
};
