import { DRY_RUN, FORCE, SELECT, USER } from "#cli/options.ts";
import { POLICIES } from "./options.ts";
import type { CommandSpec } from "./spec.ts";

/** The commands `--help` lists under Share, in the order it lists them. */
export const SHARE: readonly CommandSpec[] = [
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
    load: () => import("#cli/commands/sync.ts"),
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
      {
        command: "aireg publish --to acme/engineering",
        what: "the manifest's exports, with their dependencies",
      },
    ],
    docs: "publish",
    options: [
      {
        flag: "--to",
        value: "<registry>/<namespace>",
        describe:
          "Where to publish: a declared registry or a registry folder, and a namespace; for exports, one of publish.to",
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
    load: () => import("#cli/commands/publish.ts"),
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
    load: () => import("#cli/commands/watch.ts"),
  },
];
