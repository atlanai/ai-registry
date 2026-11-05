import { KINDS } from "#adapter/kinds.ts";
import { list } from "#adapter/text.ts";
import type { CommandSpec } from "#cli/commands/command.ts";
import { REGISTRY, USER } from "#cli/options/flags.ts";

export const SEARCH_COMMAND: CommandSpec = {
  name: "search",
  summary: "Find artifacts in the registries you have declared",
  group: "Install",
  usage: ["aireg search <query> [--registry <registry>] [--kind <kind>] [-g]"],
  examples: [
    { command: "aireg search review", what: "every artifact about review" },
    { command: "aireg search lint --kind agent -r acme", what: "only agents, only in acme" },
  ],
  docs: "search",
  options: [
    { ...REGISTRY, describe: "Search only this registry, by name or address" },
    {
      flag: "--kind",
      value: "<kind>",
      choices: KINDS,
      describe: `Only this kind: ${list(KINDS, "or")}`,
    },
    USER,
  ],
};
