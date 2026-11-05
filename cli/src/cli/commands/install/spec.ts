import type { CommandSpec } from "#cli/commands/command.ts";
import { COPY, DRY_RUN, FOR, FORCE, FROZEN, USER } from "#cli/options/flags.ts";

export const INSTALL_COMMAND: CommandSpec = {
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
};
