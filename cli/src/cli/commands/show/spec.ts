import type { CommandSpec } from "#cli/commands/command.ts";
import { REGISTRY, SOURCE, USER } from "#cli/options/flags.ts";

export const SHOW_COMMAND: CommandSpec = {
  name: "show",
  summary: "Print an artifact without installing it",
  group: "Install",
  usage: [
    "aireg show <registry>/<namespace>/[<kind>/]<name>[@<version>]",
    "aireg show <namespace>/[<kind>/]<name>[@<version>] --registry <registry>",
    "aireg show ./<path>",
  ],
  examples: [
    {
      command: "aireg show acme/engineering/pr-review",
      what: "read a skill before installing it",
    },
    { command: "aireg show ./skills/draft-skill", what: "read one you are writing" },
  ],
  docs: "show",
  options: [
    { ...REGISTRY, describe: "The registry to read from, by name or address" },
    ...SOURCE,
    USER,
  ],
  maxArguments: 1,
};
