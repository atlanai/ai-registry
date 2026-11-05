import type { CommandSpec } from "#cli/commands/command.ts";
import { ADAPTER, TOKEN_STDIN } from "#cli/options/flags.ts";

export const AUTH_COMMAND: CommandSpec = {
  name: "auth",
  summary: "Sign in to your registries, and manage the accounts aireg uses",
  group: "Set up",
  usage: ["aireg auth [<action>] [<registry>] [options]"],
  examples: [{ command: "aireg auth login acme", what: "sign in to the acme registry" }],
  docs: "auth",
  actions: [
    {
      name: "login",
      summary: "Sign in to a registry",
      usage: ["aireg auth login <registry> [options]"],
      maxArguments: 1,
      options: [
        { flag: "--address", value: "<address>", describe: "The address to sign in to" },
        ADAPTER,
        TOKEN_STDIN,
      ],
    },
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the accounts aireg signs in with",
      usage: ["aireg auth list"],
      maxArguments: 0,
    },
    {
      name: "logout",
      summary: "Sign out, keeping the account",
      usage: ["aireg auth logout <registry>"],
      maxArguments: 1,
    },
    {
      name: "remove",
      aliases: ["rm"],
      summary: "Delete an account",
      usage: ["aireg auth remove <registry>"],
      maxArguments: 1,
    },
  ],
};
