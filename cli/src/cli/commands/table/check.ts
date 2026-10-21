import { ALL, USER } from "#cli/options.ts";
import type { CommandSpec } from "./spec.ts";

/** The commands `--help` lists under Check, in the order it lists them. */
export const CHECK: readonly CommandSpec[] = [
  {
    name: "console",
    summary: "Open a full-screen view of installed artifacts, jobs and registries",
    group: "Check",
    usage: ["aireg console [--account <account>]"],
    examples: [
      { command: "aireg console", what: "open the console" },
      { command: "aireg console --json", what: "the same state, as data" },
    ],
    docs: "console",
    options: [{ flag: "--account", value: "<account>", describe: "The account to open on" }],
    load: () => import("#cli/commands/console.ts"),
  },
  {
    name: "status",
    summary: "Check installed artifacts against the lockfile, and list the ones nothing manages",
    group: "Check",
    usage: ["aireg status [-g]"],
    examples: [
      { command: "aireg status", what: "check this project" },
      { command: "aireg status -g", what: "check your user scope" },
    ],
    docs: "status",
    options: [USER],
    load: () => import("#cli/commands/status.ts"),
  },
  {
    name: "list",
    aliases: ["ls"],
    summary: "List what is installed",
    group: "Check",
    usage: ["aireg list [-g]", "aireg list <name> [-g]"],
    examples: [
      { command: "aireg list", what: "what this project installs" },
      { command: "aireg list engineering/pr-review", what: "where one came from" },
    ],
    docs: "list",
    options: [USER],
    maxArguments: 1,
    load: () => import("#cli/commands/list.ts"),
  },
  {
    name: "outdated",
    summary: "Check each registry for newer versions of what is installed",
    group: "Check",
    usage: ["aireg outdated [-g]"],
    examples: [{ command: "aireg outdated", what: "what has a newer version" }],
    docs: "outdated",
    options: [USER],
    load: () => import("#cli/commands/outdated.ts"),
  },
  {
    name: "harnesses",
    summary: "List the harnesses aireg can install into, and which this machine has",
    group: "Check",
    usage: ["aireg harnesses [--all]", "aireg harnesses show <id>", "aireg harnesses check <file>"],
    examples: [{ command: "aireg harnesses", what: "which coding agents this machine has" }],
    docs: "harnesses",
    options: [{ ...ALL, describe: "List every harness aireg supports, not only those found" }],
    actions: [
      {
        name: "show",
        summary: "Print where a harness takes each kind, as aireg resolved it",
        usage: ["aireg harnesses show <id>"],
        maxArguments: 1,
        examples: [{ command: "aireg harnesses show codex", what: "where Codex gets each kind" }],
      },
      {
        name: "check",
        summary: "Check a harness file before you use it",
        usage: ["aireg harnesses check <file>"],
        maxArguments: 1,
        examples: [{ command: "aireg harnesses check tool.json", what: "is this file usable?" }],
      },
    ],
    load: () => import("#cli/commands/harnesses.ts"),
  },
];
