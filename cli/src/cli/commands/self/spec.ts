import type { CommandSpec } from "#cli/commands/command.ts";
import { DRY_RUN, FORCE } from "#cli/options/flags.ts";

export const SELF_COMMAND: CommandSpec = {
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
};
