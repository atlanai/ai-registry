import type { CommandSpec } from "#cli/commands/command.ts";
import { DRY_RUN, POLICIES, SELECT, USER } from "#cli/options/flags.ts";

// `resolve` sets no maxArguments: `resolve <job> <name>` must reach its own checks.
export const SYNC_COMMAND: CommandSpec = {
  name: "sync",
  summary: "Sync this project with its registries",
  group: "Share",
  usage: ["aireg sync [<registry>] [options]", "aireg sync resolve <name> --mine | --theirs"],
  examples: [
    { command: "aireg sync --dry-run", what: "what would change" },
    { command: "aireg sync --publish on", what: "pull changes, and publish your edits" },
  ],
  docs: "sync",
  options: [...POLICIES, SELECT, DRY_RUN, USER],
  maxArguments: 1,
  actions: [
    {
      name: "resolve",
      summary: "Settle an artifact edited both here and in the registry",
      usage: ["aireg sync resolve <name> --mine | --theirs [options]"],
      examples: [
        {
          command: "aireg sync resolve pr-review --mine",
          what: "keep your edit as a new version",
        },
      ],
      options: [
        { flag: "--mine", describe: "Publish your copy as a new version" },
        { flag: "--theirs", describe: "Take the registry's copy" },
        { flag: "--job", value: "<job>", describe: "Settle a conflict this job left waiting" },
        USER,
      ],
    },
  ],
};
