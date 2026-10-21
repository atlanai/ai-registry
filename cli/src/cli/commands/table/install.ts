import { list } from "#adapter/text.ts";
import { ALL, AS, COPY, DRY_RUN, FOR, FORCE, FROZEN, SELECT, SOURCE, USER } from "#cli/options.ts";
import { KINDS } from "#core/kinds.ts";
import { REGISTRY } from "./options.ts";
import type { CommandSpec } from "./spec.ts";

/** The commands `--help` lists under Install, in the order it lists them. */
export const INSTALL: readonly CommandSpec[] = [
  {
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
      { flag: "--kind", value: "<kind>", describe: `Only this kind: ${list(KINDS, "or")}` },
      USER,
    ],
    load: () => import("#cli/commands/search.ts"),
  },
  {
    name: "add",
    summary: "Install artifacts from a registry",
    group: "Install",
    usage: [
      "aireg add <registry>[/<namespace>[/[<kind>/]<name>[@<version> | @<range>]]] [options]",
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
        command: "aireg add acme/engineering/pr-review@^1.2",
        what: "one artifact, at the newest version in a range",
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
    load: () => import("#cli/commands/add.ts"),
  },
  {
    name: "remove",
    aliases: ["rm"],
    summary: "Uninstall artifacts",
    group: "Install",
    usage: ["aireg remove <name>... [options]", "aireg remove --all [options]"],
    examples: [
      { command: "aireg remove pr-review", what: "one artifact" },
      { command: "aireg remove -g --all", what: "everything in your user scope" },
    ],
    docs: "remove",
    options: [SELECT, ALL, USER, DRY_RUN, FROZEN, FORCE],
    load: () => import("#cli/commands/remove.ts"),
  },
  {
    name: "install",
    aliases: ["i"],
    summary: "Make this project match its manifest",
    group: "Install",
    usage: ["aireg install [options]"],
    examples: [
      { command: "aireg install", what: "what the manifest names, after a clone" },
      { command: "aireg install --frozen", what: "fail if the lockfile or manifest would change" },
    ],
    docs: "install",
    options: [FROZEN, FORCE, FOR, COPY, DRY_RUN, USER],
    load: () => import("#cli/commands/install.ts"),
  },
  {
    name: "update",
    aliases: ["upgrade"],
    summary: "Take the newest version each registry offers",
    group: "Install",
    usage: ["aireg update [<name> | <registry>]... [options]"],
    examples: [
      { command: "aireg update", what: "the newest of everything" },
      { command: "aireg update acme", what: "only what came from acme" },
    ],
    docs: "update",
    options: [FROZEN, FOR, COPY, DRY_RUN, USER],
    load: () => import("#cli/commands/update.ts"),
  },
  {
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
    load: () => import("#cli/commands/show.ts"),
  },
];
