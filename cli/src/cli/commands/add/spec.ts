import type { CommandSpec } from "#cli/commands/command.ts";
import {
  ALL,
  AS,
  COPY,
  DRY_RUN,
  FOR,
  FORCE,
  FROZEN,
  REGISTRY,
  SELECT,
  SOURCE,
  USER,
} from "#cli/options/flags.ts";

export const ADD_COMMAND: CommandSpec = {
  name: "add",
  summary: "Install artifacts from a registry",
  group: "Install",
  usage: [
    "aireg add <registry>[/<namespace>[/[<kind>/]<name>[@<version>]]] [options]",
    "aireg add <namespace>[/<name>]... --registry <registry> [options]",
    "aireg add <address> [-s <name>]... [--as <name>] [options]",
    "aireg add --from <file> [options]",
    "aireg add",
  ],
  examples: [
    { command: "aireg add acme/engineering", what: "a namespace, in this project" },
    {
      command: "aireg add -g acme/engineering/pr-review@1.2.0",
      what: "one artifact, pinned, for you in every project",
    },
    {
      command: "aireg add ../acme-registry/artifacts/engineering/skill/pr-review",
      what: "one artifact, from its folder in a registry",
    },
  ],
  docs: "add",
  options: [
    SELECT,
    ALL,
    FOR,
    COPY,
    AS,
    { ...REGISTRY, describe: "The registry to install from, by name or address" },
    ...SOURCE,
    {
      flag: "--from",
      value: "<file>",
      describe: "Add the skills another installer's lock file records, such as skills-lock.json",
    },
    {
      flag: "--trust",
      value: "<plugin>",
      multiple: true,
      describe:
        "Install this plugin although it carries hooks, servers or executables that run as you",
    },
    {
      flag: "--no-auto-update",
      describe: "Do not keep a user scope install up to date in the background",
    },
    USER,
    DRY_RUN,
    FROZEN,
    FORCE,
  ],
};
