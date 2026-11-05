import { CONSOLE_COMMAND } from "#cli/commands/console/spec.ts";
import { collect } from "#cli/console/data/state.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { contributedPanels, contributedUpstream } from "#core/host/load.ts";
import type { CommandContext } from "./command.ts";

/**
 * The renderer sits behind a dynamic import, so nothing that only syncs pays for
 * it. Contributed tabs load first: the render is synchronous.
 */
export async function run(context: CommandContext): Promise<void> {
  const { positionals, own } = parse<{ account?: string }>(context.argv, CONSOLE_COMMAND);
  noArguments(positionals, "console");

  if (context.printer.format !== "json" && !interactive()) {
    throw new AiregError("The console needs an interactive terminal.", {
      code: ErrorCode.Usage,
      hint: "Run `aireg console --json` for the same state as data.",
    });
  }

  const state = await collect(context, { accountId: own.account });
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: state });
    return;
  }

  // Ink's chalk reads argv itself and takes a bare `--color` as "always".
  if (!context.printer.style.on) process.env.FORCE_COLOR = "0";
  const [{ runApp }, panels, upstream] = await Promise.all([
    import("#cli/console/ui/run.ts"),
    contributedPanels(),
    contributedUpstream(),
  ]);

  // Resolved once rather than per link: it reads the account's token.
  const viewer = state.account === undefined ? undefined : await upstream?.viewer?.(state.account);

  await runApp({ context, initial: state, panels, upstream, viewer });
}

/** Ink owns the screen and reads raw keys; neither works through a pipe. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
