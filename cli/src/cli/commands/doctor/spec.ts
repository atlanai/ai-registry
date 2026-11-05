import type { CommandSpec } from "#cli/commands/command.ts";

export const DOCTOR_COMMAND: CommandSpec = {
  name: "doctor",
  summary: "Check that this machine can install artifacts",
  group: "Maintain",
  usage: ["aireg doctor"],
  examples: [{ command: "aireg doctor", what: "check this machine before installing" }],
  docs: "doctor",
};
