import { list } from "#adapter/text.ts";
import {
  ADAPTER,
  ALL,
  AS,
  COPY,
  DRY_RUN,
  FOR,
  FORCE,
  FROZEN,
  SELECT,
  SOURCE,
  USER,
} from "#cli/options.ts";
import { DEFAULT_INTERVAL_SECONDS, STEP_POLICIES } from "#core/config/model.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import { KINDS } from "#core/kinds.ts";
import { RUN_MODES } from "#core/run/model.ts";
import { IMPORTABLE_TARGETS } from "#core/target/index.ts";
import { MAX_PAGE_SIZE } from "#daemon/rpc/protocol.ts";
import type { CommandSpec } from "./index.ts";

const TOKEN_STDIN: OptionSpec = {
  flag: "--token-stdin",
  describe: "Read the registry's token from standard input",
};

const REGISTRY: OptionSpec = {
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

const policy = (name: string, what: string): OptionSpec => ({
  flag: `--${name}`,
  value: "<policy>",
  describe: `${what}: ${list(STEP_POLICIES, "or")}`,
});

const POLICIES: readonly OptionSpec[] = [
  policy("pull", "What to do with changes the registry made"),
  policy("publish", "What to do with edits made here"),
  policy("delete", "What to do with artifacts deleted here"),
  policy("adopt", "What to do with artifacts no registry has yet"),
  policy("claim", "Whether to manage a folder that matches the registry"),
];

/** Every built-in command, in the order `--help` lists each group. */
export const COMMANDS: readonly CommandSpec[] = [
  {
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
    load: () => import("./init.ts"),
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
    load: () => import("./registry.ts"),
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
    load: () => import("./auth.ts"),
  },

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
    load: () => import("./search.ts"),
  },
  {
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
    load: () => import("./add.ts"),
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
    load: () => import("./remove.ts"),
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
    load: () => import("./install.ts"),
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
    load: () => import("./update.ts"),
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
    load: () => import("./show.ts"),
  },

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
    load: () => import("./console.ts"),
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
    load: () => import("./status.ts"),
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
    load: () => import("./list.ts"),
  },
  {
    name: "outdated",
    summary: "Check each registry for newer versions of what is installed",
    group: "Check",
    usage: ["aireg outdated [-g]"],
    examples: [{ command: "aireg outdated", what: "what has a newer version" }],
    docs: "outdated",
    options: [USER],
    load: () => import("./outdated.ts"),
  },
  {
    name: "targets",
    formerly: ["harnesses"],
    summary: "List the targets aireg can install into, and which this machine has",
    group: "Check",
    usage: ["aireg targets [--all]", "aireg targets show <id>", "aireg targets check <file>"],
    examples: [{ command: "aireg targets", what: "which coding agents this machine has" }],
    docs: "targets",
    options: [{ ...ALL, describe: "List every target aireg supports, not only those found" }],
    actions: [
      {
        name: "show",
        summary: "Print where a target takes each kind, as aireg resolved it",
        usage: ["aireg targets show <id>"],
        maxArguments: 1,
        examples: [{ command: "aireg targets show codex", what: "where Codex gets each kind" }],
      },
      {
        name: "check",
        summary: "Check a target file before you use it",
        usage: ["aireg targets check <file>"],
        maxArguments: 1,
        examples: [{ command: "aireg targets check tool.json", what: "is this file usable?" }],
      },
    ],
    load: () => import("./targets.ts"),
  },

  {
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
        // No limit: `resolve <job> <name>` must reach resolve's own checks.
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
    load: () => import("./sync.ts"),
  },
  {
    name: "publish",
    summary: "Publish artifacts to a registry, as new versions",
    group: "Share",
    usage: ["aireg publish [<path> | <glob> | <name>]... [options]"],
    examples: [
      {
        command: "aireg publish .claude/skills/triage --to acme/engineering",
        what: "a skill, to a team registry",
      },
      {
        command: "aireg publish pr-review --bump minor",
        what: "a new minor version of an edited skill",
      },
    ],
    docs: "publish",
    options: [
      {
        flag: "--to",
        value: "<registry>/<namespace>",
        describe: "Where to publish: a declared registry or a registry folder, and a namespace",
      },
      {
        flag: "--bump",
        value: "<level>",
        describe: "How far to move the version: patch, minor or major",
      },
      {
        flag: "--message",
        short: "-m",
        value: "<message>",
        describe: "The change message, for a registry that records one",
      },
      {
        flag: "--changed-since",
        value: "<commit>",
        describe: "Only the artifacts whose files changed since this commit",
      },
      { ...FORCE, describe: "Publish an edit made on an older version over a newer one" },
      DRY_RUN,
      USER,
    ],
    load: () => import("./publish.ts"),
  },
  {
    name: "watch",
    summary: "Publish a folder's skills and agents whenever they change",
    group: "Share",
    usage: ["aireg watch [<action>] [options]"],
    examples: [
      {
        command: "aireg watch add ~/.claude/skills --to acme/engineering -g",
        what: "publish your skills as you edit them",
      },
      {
        command: "aireg watch remove ~/.claude/skills -g",
        what: "stop, and keep what you installed up to date",
      },
    ],
    docs: "watch",
    actions: [
      {
        name: "add",
        summary: "Publish a folder whenever it changes",
        usage: ["aireg watch add <folder>... --to <registry>/<namespace> [options]"],
        options: [
          {
            flag: "--to",
            value: "<registry>/<namespace>",
            describe: "Where the folder publishes",
          },
          USER,
        ],
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Stop publishing a folder, and keep its scope in sync",
        usage: ["aireg watch remove <folder>... [options]"],
        options: [USER],
      },
      {
        name: "list",
        aliases: ["ls"],
        summary: "List the folders published as they change",
        usage: ["aireg watch list"],
        maxArguments: 0,
      },
    ],
    load: () => import("./watch.ts"),
  },

  {
    name: "job",
    summary: "Manage background jobs and read their runs",
    group: "Automate",
    usage: ["aireg job [<action>] [options]"],
    examples: [
      {
        command: "aireg job add -g --registry acme",
        what: "keep your user scope in sync with acme",
      },
      { command: "aireg job runs", what: "what the jobs did" },
    ],
    docs: "job",
    actions: [
      {
        name: "add",
        summary: "Add a job that keeps a folder in sync with a registry",
        usage: [
          "aireg job add [<folder>] --registry <registry> [options]",
          "aireg job add [<folder>] --watch <folder>... --to <registry>/<namespace> [options]",
        ],
        maxArguments: 1,
        options: [
          {
            flag: "--registry",
            value: "<registry>",
            describe: "The registry to keep in sync with",
          },
          {
            flag: "--watch",
            value: "<folder>",
            multiple: true,
            describe: "A folder to publish as it changes, as `aireg watch add` does (repeatable)",
          },
          {
            flag: "--to",
            value: "<registry>/<namespace>",
            describe: "Where the watched folders publish",
          },
          {
            flag: "--interval",
            value: "<seconds>",
            describe: `How often the job runs, in seconds (default ${DEFAULT_INTERVAL_SECONDS})`,
          },
          {
            flag: "--name",
            value: "<name>",
            describe: "An id for the job, in place of the default",
          },
          ...POLICIES,
          { ...SELECT, describe: "Also add these artifacts to the manifest" },
          USER,
          FOR,
          {
            flag: "--account",
            value: "<account>",
            describe: "The account an adapter's job type runs as",
          },
          { flag: "--kind", value: "<kind>", describe: "A job type an installed adapter adds" },
        ],
      },
      {
        name: "list",
        aliases: ["ls"],
        summary: "List every job on this machine",
        usage: ["aireg job list"],
        maxArguments: 0,
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Remove a job",
        usage: ["aireg job remove <job>"],
        maxArguments: 1,
      },
      {
        name: "start",
        summary: "Run a job now",
        usage: ["aireg job start <job> [--mode <mode>]"],
        maxArguments: 1,
        options: [
          {
            flag: "--mode",
            value: "<mode>",
            describe: `What the run does: ${list(RUN_MODES, "or")} (default sync)`,
          },
        ],
      },
      {
        name: "enable",
        summary: "Turn a job's schedule on",
        usage: ["aireg job enable <job>"],
        maxArguments: 1,
      },
      {
        name: "disable",
        summary: "Turn a job's schedule off",
        usage: ["aireg job disable <job>"],
        maxArguments: 1,
      },
      {
        name: "pause",
        summary: "Stop the schedule for every job",
        usage: ["aireg job pause"],
      },
      {
        name: "resume",
        summary: "Restart the schedule for every job",
        usage: ["aireg job resume"],
      },
      {
        name: "runs",
        summary: "List recent runs, or one run's events",
        usage: ["aireg job runs [<run>] [options]"],
        maxArguments: 1,
        options: [
          { flag: "--job", value: "<job>", describe: "Only this job's runs" },
          { flag: "--state", value: "<state>", describe: "Only runs in this state" },
          {
            flag: "--limit",
            value: "<n>",
            describe: `How many runs to list, from 1 to ${MAX_PAGE_SIZE}`,
          },
          { flag: "--follow", describe: "With a run id, print its events until it finishes" },
        ],
      },
      {
        name: "retry",
        summary: "Run an earlier run's job again",
        usage: ["aireg job retry <run>"],
        maxArguments: 1,
      },
      {
        name: "cancel",
        summary: "Stop a queued or running run",
        usage: ["aireg job cancel <run>"],
        maxArguments: 1,
      },
    ],
    load: () => import("./job.ts"),
  },
  {
    name: "daemon",
    summary: "Start, stop or check the background daemon that runs jobs",
    group: "Automate",
    usage: ["aireg daemon [<action>]"],
    examples: [
      { command: "aireg daemon status", what: "is it running?" },
      { command: "aireg daemon autostart on", what: "start it when you log in" },
    ],
    docs: "daemon",
    actions: [
      {
        name: "start",
        summary: "Start the daemon",
        usage: ["aireg daemon start"],
        maxArguments: 0,
      },
      {
        name: "stop",
        summary: "Stop the daemon",
        usage: ["aireg daemon stop"],
        maxArguments: 0,
      },
      {
        name: "restart",
        summary: "Restart the daemon",
        usage: ["aireg daemon restart"],
        maxArguments: 0,
      },
      {
        name: "status",
        summary: "Show whether the daemon is running",
        usage: ["aireg daemon status"],
        maxArguments: 0,
      },
      {
        name: "autostart",
        summary: "Start the daemon when you log in, or stop doing so",
        usage: ["aireg daemon autostart [on | off | status]"],
        maxArguments: 1,
      },
    ],
    load: () => import("./daemon.ts"),
  },

  {
    name: "config",
    summary: "Read and write aireg's own settings",
    group: "Maintain",
    usage: ["aireg config [<action>]"],
    examples: [
      {
        command: "aireg config set defaults.namespace acme/engineering",
        what: "publish there by default",
      },
      { command: "aireg config get defaults.namespace", what: "read a setting in a script" },
    ],
    docs: "config",
    actions: [
      {
        name: "list",
        aliases: ["ls"],
        summary: "List every setting",
        usage: ["aireg config list"],
        maxArguments: 0,
      },
      {
        name: "get",
        summary: "Print one setting",
        usage: ["aireg config get <key>"],
        maxArguments: 1,
      },
      {
        name: "set",
        summary: "Change one setting",
        usage: ["aireg config set <key> <value>"],
        maxArguments: 2,
      },
      {
        name: "unset",
        summary: "Put one setting back to its default",
        usage: ["aireg config unset <key>"],
        maxArguments: 1,
      },
      {
        name: "path",
        summary: "Print where the settings file is",
        usage: ["aireg config path"],
        maxArguments: 0,
      },
    ],
    load: () => import("./config.ts"),
  },
  {
    name: "doctor",
    summary: "Check that this machine can install artifacts",
    group: "Maintain",
    usage: ["aireg doctor"],
    examples: [{ command: "aireg doctor", what: "check this machine before installing" }],
    docs: "doctor",
    load: () => import("./doctor.ts"),
  },
  {
    name: "unlock",
    summary: "Show or clear a stuck write lock",
    group: "Maintain",
    usage: ["aireg unlock [-g]", "aireg unlock [-g] <id>"],
    examples: [{ command: "aireg unlock", what: "see what holds this project's write lock" }],
    docs: "unlock",
    options: [USER],
    maxArguments: 1,
    load: () => import("./unlock.ts"),
  },
  {
    name: "adapter",
    summary: "Install an adapter, or write a new one",
    group: "Maintain",
    usage: ["aireg adapter [<action>] [<id>] [options]"],
    examples: [
      { command: "aireg adapter install acme", what: "read acme registries" },
      { command: "aireg adapter init acme", what: "start an adapter package to develop" },
    ],
    docs: "adapter",
    actions: [
      {
        name: "install",
        summary: "Install an adapter from the release server",
        usage: ["aireg adapter install <id> [options]"],
        maxArguments: 1,
        options: [DRY_RUN, { ...FORCE, describe: "Install it again even if it is installed" }],
      },
      {
        name: "list",
        aliases: ["ls"],
        summary: "List the adapters this machine has",
        usage: ["aireg adapter list"],
        maxArguments: 0,
      },
      {
        name: "remove",
        aliases: ["rm"],
        summary: "Remove an adapter",
        usage: ["aireg adapter remove <id> [--dry-run]"],
        maxArguments: 1,
        options: [DRY_RUN],
      },
      {
        name: "init",
        summary: "Write a new adapter package to start from",
        usage: ["aireg adapter init <id> [options]"],
        maxArguments: 1,
        options: [
          { flag: "--dir", value: "<folder>", describe: "The folder to write the package into" },
          DRY_RUN,
          { ...FORCE, describe: "Overwrite the folder if it exists" },
        ],
      },
    ],
    load: () => import("./adapter.ts"),
  },
  {
    name: "logs",
    summary: "Read aireg's diagnostic logs",
    group: "Maintain",
    usage: ["aireg logs [options]"],
    examples: [
      { command: "aireg logs --daemon --level warn", what: "why a background sync failed" },
      { command: "aireg logs --cli --since 5m", what: "the CLI's last five minutes" },
    ],
    docs: "logs",
    options: [
      { flag: "--follow", short: "-f", describe: "Keep printing new entries as they are written" },
      {
        flag: "--tail",
        short: "-n",
        value: "<count>",
        describe: "How many of the newest entries to print",
      },
      {
        flag: "--since",
        value: "<time>",
        describe: "Only entries since this time: 15m, 2h, 1d or a date",
      },
      { flag: "--until", value: "<time>", describe: "Only entries until this time" },
      { flag: "--level", value: "<level>", describe: "Only entries at this level or above" },
      { flag: "--grep", value: "<text>", describe: "Only entries that contain this text" },
      { flag: "--daemon", describe: "Read the daemon's log" },
      { flag: "--cli", describe: "Read the CLI's log" },
      { flag: "--stderr", describe: "Read the daemon's stderr" },
      { flag: "--previous", describe: "Read the last rotated copy instead" },
    ],
    load: () => import("./logs.ts"),
  },
  {
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
    load: () => import("./self.ts"),
  },
];
