import type { CommandContext } from "#cli/commands/command.ts";
import { type OutputFormat, Printer } from "#core/term/printer.ts";

export interface CommandContextOptions {
  cwd?: string;
  format?: OutputFormat;
  /** Collects what the command prints; read it with `printed.join("")`. */
  printed?: string[];
}

/** A context as `main.ts` gives a built-in command, with no host to connect accounts or runs. */
export function commandContext(
  argv: string[],
  options: CommandContextOptions = {},
): CommandContext {
  const printed = options.printed ?? [];
  return {
    argv,
    cwd: options.cwd ?? process.cwd(),
    printer: new Printer({
      format: options.format ?? "json",
      out: { write: (chunk: string) => printed.push(chunk) > 0, isTTY: false },
    }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}
