import { CONSOLE_COMMAND } from "#cli/commands/console/spec.ts";
import { collect } from "#cli/console/data/state.ts";
import { noArguments, type OptionsOf, parse } from "#cli/options/parse.ts";
import type { ConsoleState } from "#core/console/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { contributedPanels, contributedUpstream } from "#core/host/load.ts";
import { defineCommand, STREAMED } from "./define.ts";

type Options = OptionsOf<typeof CONSOLE_COMMAND.options>;

/**
 * The renderer sits behind a dynamic import, so nothing that only syncs pays for
 * it. Contributed tabs load first: the render is synchronous.
 */
export const { run } = defineCommand({
  spec: CONSOLE_COMMAND,
  parse(argv): Options {
    const { positionals, own } = parse<Options>(argv, CONSOLE_COMMAND);
    noArguments(positionals, "console");
    return own;
  },
  async run(options, context): Promise<ConsoleState | typeof STREAMED> {
    if (context.printer.format !== "json" && !interactive()) {
      throw new AiregError("The console needs an interactive terminal.", {
        code: ErrorCode.Usage,
        hint: "Run `aireg console --json` for the same state as data.",
      });
    }

    const state = await collect(context, { accountId: options.account });
    if (context.printer.format === "json") return state;

    // Ink's chalk reads argv itself and takes a bare `--color` as "always".
    if (!context.printer.style.on) process.env.FORCE_COLOR = "0";
    const [{ runApp }, panels, upstream] = await Promise.all([
      import("#cli/console/ui/run.ts"),
      contributedPanels(),
      contributedUpstream(),
    ]);

    // Resolved once rather than per link: it reads the account's token.
    const viewer =
      state.account === undefined ? undefined : await upstream?.viewer?.(state.account);

    await runApp({ context, initial: state, panels, upstream, viewer });
    return STREAMED;
  },
  // run draws the full-screen app itself, so there is no text to print.
  text() {},
});

/** Ink owns the screen and reads raw keys; neither works through a pipe. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
