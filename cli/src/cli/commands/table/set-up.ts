import { list } from "#adapter/text.ts";
import { ADAPTER, AS, DRY_RUN, FOR, FORCE, SOURCE, USER } from "#cli/options.ts";
import { IMPORTABLE_HARNESSES } from "#core/harness/index.ts";
import { NAMESPACE, TOKEN_STDIN } from "./options.ts";
import type { CommandSpec } from "./spec.ts";

/** The commands `--help` lists under Set up, in the order it lists them. */
export const SET_UP: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Set up a project (creates .registry/manifest.yml)",
    group: "Set up",
    usage: [
      "aireg init [--for <harness>,...] [--force]",
      "aireg init --registry <registry> [--as <name>] [--watch] [options]",
    ],
    examples: [
      { command: "aireg init --for claude,cursor", what: "a project for Claude Code and Cursor" },
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
        value: "<harness>",
        describe: `Import what these harness folders hold: ${list([...IMPORTABLE_HARNESSES, "all"], "or")}`,
      },
      ADAPTER,
      TOKEN_STDIN,
    ],
    load: () => import("#cli/commands/init.ts"),
  },
  {
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
    load: () => import("#cli/commands/registry.ts"),
  },
  {
    name: "auth",
    summary: "Sign in to your registries, and manage the accounts aireg uses",
    group: "Set up",
    usage: ["aireg auth [<action>] [<registry>] [options]"],
    examples: [{ command: "aireg auth login acme", what: "sign in to the acme registry" }],
    docs: "auth",
    actions: [
      {
        name: "login",
        summary: "Sign in to a registry",
        usage: ["aireg auth login <registry> [options]"],
        maxArguments: 1,
        options: [
          { flag: "--address", value: "<address>", describe: "The address to sign in to" },
          ADAPTER,
          TOKEN_STDIN,
        ],
      },
      {
        name: "list",
        aliases: ["ls"],
        summary: "List the accounts aireg signs in with",
        usage: ["aireg auth list"],
        maxArguments: 0,
      },
      {
        name: "logout",
        summary: "Sign out, keeping the account",
        usage: ["aireg auth logout <registry>"],
        maxArguments: 1,
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Delete an account",
        usage: ["aireg auth remove <registry>"],
        maxArguments: 1,
      },
    ],
    load: () => import("#cli/commands/auth.ts"),
  },
];
