import { BUMPS } from "#adapter/semver.ts";
import type { CommandSpec } from "#cli/commands/command.ts";
import { DRY_RUN, FORCE, USER } from "#cli/options/flags.ts";

export const PUBLISH_COMMAND: CommandSpec = {
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
      choices: BUMPS,
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
};
