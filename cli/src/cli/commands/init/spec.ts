import { list } from "#adapter/text.ts";
import type { CommandSpec } from "#cli/commands/command.ts";
import { ADAPTER, AS, FOR, FORCE, TOKEN_STDIN } from "#cli/options/flags.ts";
import { IMPORTABLE_TARGETS } from "#core/target/ids.ts";

export const INIT_COMMAND: CommandSpec = {
  name: "init",
  summary: "Set up a project (creates .registry/manifest.yml)",
  group: "Set up",
  usage: [
    "aireg init [--for <target>,...] [--force]",
    "aireg init --registry <registry> [--as <name>] [--watch] [options]",
  ],
  examples: [
    {
      command: "aireg init --for claude-code,cursor",
      what: "a project for Claude Code and Cursor",
    },
    {
      command: "aireg init --registry github.com/acme/ai-registry --as acme --watch",
      what: "set up from a team registry, kept in sync",
    },
  ],
  docs: "init",
  options: [
    FOR,
    { ...FORCE, describe: "Replace an existing manifest, keeping the registries it declares" },
    {
      flag: "--registry",
      value: "<registry>",
      describe: "The registry to set the project up from",
    },
    AS,
    {
      flag: "--publish-to",
      value: "<registry>/<namespace>",
      describe: "Where aireg publish sends work when --to is not given",
    },
    { flag: "--watch", describe: "Keep the project in sync with the registry in the background" },
    {
      flag: "--import",
      value: "<target>",
      describe: `Import what these target folders hold: ${list([...IMPORTABLE_TARGETS, "all"], "or")}`,
    },
    ADAPTER,
    TOKEN_STDIN,
  ],
};
