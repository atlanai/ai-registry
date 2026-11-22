import type { UiResult } from "#cli/commands/ui/result.ts";
import { UI_COMMAND } from "#cli/commands/ui/spec.ts";
import { noArguments, type OptionsOf, parse } from "#cli/options/parse.ts";
import { openBrowser } from "#cli/ui/launch.ts";
import { isCI } from "#core/env.ts";
import { defineCommand, STREAMED } from "./define.ts";

type Options = OptionsOf<typeof UI_COMMAND.options>;

/** The page and its server load only when this command runs. */
export const { run } = defineCommand({
  spec: UI_COMMAND,
  parse(argv): Options {
    const { positionals, own } = parse<Options>(argv, UI_COMMAND);
    noArguments(positionals, "ui");
    return own;
  },
  async run(options, context): Promise<UiResult | typeof STREAMED> {
    const [{ openInstance }, { ASSETS }] = await Promise.all([
      import("#cli/ui/instance.ts"),
      import("#cli/ui/assets.ts"),
    ]);
    const serving = await openInstance({
      context,
      ...(options.port === undefined ? {} : { port: options.port }),
      assets: ASSETS,
    });
    // Listening before the browser opens, so a Ctrl+C meanwhile still closes the server.
    const stopped = serving.close === undefined ? undefined : signalled();
    const result: UiResult = { url: serving.url, port: serving.port };
    const printer = context.printer;
    if (printer.format === "json") {
      printer.json({ ok: true, data: result });
    } else {
      printer.info(`Serving the console at ${serving.url}`);
      printer.hint(
        serving.close === undefined
          ? "Reopened the running UI. Keep this launch address private."
          : "The address carries a token for this session. Press Ctrl+C to stop.",
      );
    }
    if (options["no-open"] !== true && browserWanted() && !(await openBrowser(serving.url))) {
      printer.hint(
        "Could not open your browser. Open the complete launch address above in your browser.",
      );
    }
    if (stopped !== undefined) {
      await stopped;
      await serving.close?.();
    }
    return STREAMED;
  },
  // run prints as it starts and then serves, so there is nothing left to print.
  text() {},
});

/** In CI, over SSH or with `BROWSER=none` the address printed is the way in. */
function browserWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isCI(env) && env.SSH_CONNECTION === undefined && env.BROWSER !== "none";
}

function signalled(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}
