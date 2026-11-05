import type { CommandSpec } from "#cli/commands/command.ts";

export const DAEMON_COMMAND: CommandSpec = {
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
};
