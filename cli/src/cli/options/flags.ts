import { LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import { list } from "#adapter/text.ts";
import { STEP_POLICIES } from "#core/config/model.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import { COLOR_WHEN } from "#core/term/printer.ts";

/** Scope follows the package-manager convention: this project, unless `-g`. */
export const USER: OptionSpec = {
  flag: "--user",
  short: "-g",
  describe: "Act on your user scope instead of this project",
};

export const FOR: OptionSpec = {
  flag: "--for",
  value: "<target>",
  multiple: true,
  describe: "The targets to install into, comma-separated, or * for all of them",
};

export const SELECT: OptionSpec = {
  flag: "--select",
  short: "-s",
  value: "<name>",
  multiple: true,
  describe: "The artifacts or namespaces to act on",
};

export const YES: OptionSpec = {
  flag: "--yes",
  short: "-y",
  describe: "Take the defaults without asking",
};

export const ALL: OptionSpec = { flag: "--all", describe: "Act on everything, without asking" };

export const COPY: OptionSpec = {
  flag: "--copy",
  describe: "Copy into each target folder instead of linking",
};

export const DRY_RUN: OptionSpec = {
  flag: "--dry-run",
  describe: "Print what would change without changing it",
};

export const FROZEN: OptionSpec = {
  flag: "--frozen",
  describe: "Fail with exit status 3 if the lockfile or the manifest would change",
};

export const FORCE: OptionSpec = {
  flag: "--force",
  describe: "Overwrite artifacts edited after they were installed",
};

export const AS: OptionSpec = {
  flag: "--as",
  value: "<name>",
  describe: "The name to save the registry under",
};

export const ADAPTER: OptionSpec = {
  flag: "--adapter",
  value: "<id>",
  describe: "The adapter that reads the registry, when aireg cannot tell",
};

export const TOKEN_STDIN: OptionSpec = {
  flag: "--token-stdin",
  describe: "Read the registry's token from standard input",
};

export const REGISTRY: OptionSpec = {
  flag: "--registry",
  short: "-r",
  value: "<registry>",
  describe: "The registry, by name or address",
};

export const NAMESPACE: OptionSpec = {
  flag: "--namespace",
  value: "<namespace>",
  describe: "The namespace in the registry",
};

function policy(name: string, what: string): OptionSpec {
  return {
    flag: `--${name}`,
    value: "<policy>",
    choices: STEP_POLICIES,
    describe: `${what}: ${list(STEP_POLICIES, "or")}`,
  };
}

export const POLICIES: readonly OptionSpec[] = [
  policy("pull", "What to do with changes the registry made"),
  policy("publish", "What to do with edits made here"),
  policy("delete", "What to do with artifacts deleted here"),
  policy("adopt", "What to do with artifacts no registry has yet"),
  policy("claim", "Whether to manage a folder that matches the registry"),
];

const CONFIG: OptionSpec = {
  flag: "--config",
  value: "<key>=<value>",
  multiple: true,
  describe: "A setting for that adapter (repeatable)",
};

const REF: OptionSpec = {
  flag: "--ref",
  value: "<ref>",
  describe: "For a git registry, the branch, tag or commit to read",
};

const PATH: OptionSpec = {
  flag: "--path",
  value: "<folder>",
  describe: "For a git registry, the folder that holds it",
};

const LAYOUT: OptionSpec = {
  flag: "--layout",
  value: "<layout>",
  describe: `How to read the source, instead of telling from what it holds: ${list([...LAYOUT_IDS], "or")}`,
};

/** Taken by every command that reads a registry from its address. */
export const SOURCE: readonly OptionSpec[] = [REF, PATH, ADAPTER, LAYOUT, CONFIG];

export const MAP_FORMATS = ["tree", "compact", "json"] as const;

export type MapFormat = (typeof MAP_FORMATS)[number];

/** Read before the command by main.ts, except --yes, which every command's parse accepts. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { flag: "--json", describe: "Machine-readable output" },
  { flag: "--verbose", describe: "Print each step" },
  { flag: "--quiet", short: "-q", describe: "Print only results, warnings and errors" },
  { flag: "--color", value: "<when>", describe: `Color the output: ${list(COLOR_WHEN, "or")}` },
  { flag: "--no-color", describe: "The same as --color never" },
  {
    flag: "--log-level",
    value: "<level>",
    describe: "The diagnostic log level, on stderr and in the log file",
  },
  {
    flag: "--map",
    value: "[format]",
    describe: `Print the full command tree and exit: ${list(MAP_FORMATS, "or")}`,
  },
  YES,
  { flag: "--help", short: "-h", describe: "Print help, or after a command, its help" },
  { flag: "--version", short: "-v", describe: "Print the version and exit" },
];

/** --version is read only before the command, and --map runs instead of any command. */
export const AFTER_COMMAND = GLOBAL_OPTIONS.filter(
  (option) => !["--yes", "--version", "--map"].includes(option.flag),
);
