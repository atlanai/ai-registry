import type { CommandSpec } from "#cli/commands/command.ts";

export const LOGS_COMMAND: CommandSpec = {
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
};
