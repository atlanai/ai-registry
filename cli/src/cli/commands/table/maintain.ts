import { DRY_RUN, FORCE, USER } from "#cli/options.ts";
import type { CommandSpec } from "./spec.ts";

/** The commands `--help` lists under Maintain, in the order it lists them. */
export const MAINTAIN: readonly CommandSpec[] = [
  {
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
    load: () => import("#cli/commands/config.ts"),
  },
  {
    name: "doctor",
    summary: "Check that this machine can install artifacts",
    group: "Maintain",
    usage: ["aireg doctor"],
    examples: [{ command: "aireg doctor", what: "check this machine before installing" }],
    docs: "doctor",
    load: () => import("#cli/commands/doctor.ts"),
  },
  {
    name: "unlock",
    summary: "Show or clear a stuck write lock",
    group: "Maintain",
    usage: ["aireg unlock [-g]", "aireg unlock [-g] <id>"],
    examples: [{ command: "aireg unlock", what: "see what holds this project's write lock" }],
    docs: "unlock",
    options: [USER],
    maxArguments: 1,
    load: () => import("#cli/commands/unlock.ts"),
  },
  {
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
    load: () => import("#cli/commands/adapter.ts"),
  },
  {
    name: "logs",
    summary: "Read aireg's diagnostic logs",
    group: "Maintain",
    usage: ["aireg logs [options]"],
    examples: [
      { command: "aireg logs --daemon --level warn", what: "why a background sync failed" },
      { command: "aireg logs --cli --since 5m", what: "the CLI's last five minutes" },
    ],
    docs: "logs",
    options: [
      { flag: "--follow", short: "-f", describe: "Keep printing new entries as they are written" },
      {
        flag: "--tail",
        short: "-n",
        value: "<count>",
        describe: "How many of the newest entries to print",
      },
      {
        flag: "--since",
        value: "<time>",
        describe: "Only entries since this time: 15m, 2h, 1d or a date",
      },
      { flag: "--until", value: "<time>", describe: "Only entries until this time" },
      { flag: "--level", value: "<level>", describe: "Only entries at this level or above" },
      { flag: "--grep", value: "<text>", describe: "Only entries that contain this text" },
      { flag: "--daemon", describe: "Read the daemon's log" },
      { flag: "--cli", describe: "Read the CLI's log" },
      { flag: "--stderr", describe: "Read the daemon's stderr" },
      { flag: "--previous", describe: "Read the last rotated copy instead" },
    ],
    load: () => import("#cli/commands/logs.ts"),
  },
  {
    name: "self",
    summary: "Update aireg, or uninstall it",
    group: "Maintain",
    usage: ["aireg self <action> [options]"],
    docs: "self",
    actions: [
      {
        name: "update",
        summary: "Update aireg to the latest release",
        usage: [
          "aireg self update [--check] [--dry-run] [--force]",
          "aireg self update --rollback [--dry-run]",
        ],
        maxArguments: 0,
        examples: [
          { command: "aireg self update", what: "update aireg" },
          { command: "aireg self update --check", what: "is there a newer release?" },
        ],
        options: [
          {
            flag: "--check",
            describe: "Check for a newer release without installing it",
          },
          { flag: "--rollback", describe: "Go back to the version installed before this one" },
          DRY_RUN,
          { ...FORCE, describe: "Install the newest release even if it is installed" },
        ],
      },
      {
        name: "uninstall",
        summary: "Remove aireg and your user scope from this machine",
        usage: ["aireg self uninstall [-y] [--dry-run]"],
        examples: [{ command: "aireg self uninstall --dry-run", what: "see what it removes" }],
        options: [DRY_RUN],
      },
    ],
    load: () => import("#cli/commands/self.ts"),
  },
];
