import { list } from "#adapter/text.ts";
import type { CommandSpec } from "#cli/commands/command.ts";
import { FOR, POLICIES, SELECT, USER } from "#cli/options/flags.ts";
import { DEFAULT_INTERVAL_SECONDS } from "#core/config/model.ts";
import { MINIMUM_INTERVAL_SECONDS } from "#core/config/parse-job.ts";
import { RUN_MODES, RUN_STATES } from "#core/run/model.ts";
import { MAX_PAGE_SIZE } from "#daemon/rpc/methods.ts";

export const JOB_COMMAND: CommandSpec = {
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
          integer: { min: MINIMUM_INTERVAL_SECONDS },
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
          choices: RUN_MODES,
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
        {
          flag: "--state",
          value: "<state>",
          choices: RUN_STATES,
          describe: "Only runs in this state",
        },
        {
          flag: "--limit",
          value: "<n>",
          integer: { min: 1, max: MAX_PAGE_SIZE },
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
};
