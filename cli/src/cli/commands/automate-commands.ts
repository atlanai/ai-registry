import { list } from "#adapter/text.ts";
import { FOR, SELECT, USER } from "#cli/options.ts";
import { DEFAULT_INTERVAL_SECONDS, STEP_POLICIES } from "#core/config/model.ts";
import type { OptionSpec } from "#core/host/extend.ts";
import { RUN_MODES } from "#core/run/model.ts";
import { MAX_PAGE_SIZE } from "#daemon/rpc/protocol.ts";
import type { CommandSpec } from "./index.ts";

const policy = (name: string, what: string): OptionSpec => ({
  flag: `--${name}`,
  value: "<policy>",
  describe: `${what}: ${list(STEP_POLICIES, "or")}`,
});

export const POLICIES: readonly OptionSpec[] = [
  policy("pull", "What to do with changes the registry made"),
  policy("publish", "What to do with edits made here"),
  policy("delete", "What to do with artifacts deleted here"),
  policy("adopt", "What to do with artifacts no registry has yet"),
  policy("claim", "Whether to manage a folder that matches the registry"),
];

export const AUTOMATE_COMMANDS: readonly CommandSpec[] = [
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
];
