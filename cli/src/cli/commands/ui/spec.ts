import type { CommandSpec } from "#cli/commands/command.ts";

export const UI_COMMAND = {
  name: "ui",
  summary: "Browse your registries and what is installed, in your browser",
  group: "Check",
  usage: ["aireg ui [--port <port>] [--no-open]"],
  examples: [
    { command: "aireg ui", what: "open it in your browser" },
    { command: "aireg ui --no-open --json", what: "print its address as data, for a script" },
  ],
  docs: "ui",
  maxArguments: 0,
  options: [
    {
      flag: "--port",
      value: "<port>",
      integer: { min: 1024, max: 65535 },
      describe: "Listen on this port instead of a free one",
    },
    { flag: "--no-open", describe: "Print the address without opening a browser" },
  ],
} satisfies CommandSpec;
