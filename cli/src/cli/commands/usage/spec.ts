import type { CommandSpec } from "#cli/commands/command.ts";

export const USAGE_COMMAND: CommandSpec = {
  name: "usage",
  summary: "Count runs of installed skills and agents, and share them with registries",
  group: "Check",
  usage: ["aireg usage [<action>] [options]"],
  examples: [
    { command: "aireg usage", what: "see which installed skills ran in the last 30 days" },
    {
      command: "aireg usage share acme",
      what: "send runs of acme's skills to the endpoint it names",
    },
  ],
  docs: "usage",
  actions: [
    {
      name: "show",
      summary: "Count the runs of what you installed, on this machine",
      usage: ["aireg usage [show] [--days <n>]"],
      options: [
        {
          flag: "--days",
          value: "<n>",
          integer: { min: 1, max: 365 },
          describe: "How many days back to count, 30 by default",
        },
      ],
      maxArguments: 0,
    },
    {
      name: "share",
      summary: "Send runs of a registry's artifacts to the usage endpoint it names",
      usage: [
        "aireg usage share",
        "aireg usage share <registry> [--as <name>]",
        "aireg usage share <registry> --off",
      ],
      options: [
        {
          flag: "--as",
          value: "<name>",
          describe: "Your name in what is sent, for a registry that asks for names",
        },
        { flag: "--off", describe: "Stop sending runs to this registry" },
      ],
      maxArguments: 1,
    },
    {
      name: "send",
      summary: "Count new runs and send them now, which the background service also does",
      usage: ["aireg usage send"],
      maxArguments: 0,
    },
  ],
};
