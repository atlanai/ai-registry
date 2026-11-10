import type { UiResult } from "#cli/commands/ui/result.ts";
import { UI_COMMAND } from "#cli/commands/ui/spec.ts";
import { noArguments, type OptionsOf, parse } from "#cli/options/parse.ts";
import { open } from "#core/console/actions.ts";
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
    const [{ serve }, { ASSETS }] = await Promise.all([
      import("#cli/ui/server.ts"),
      import("#cli/ui/assets.ts"),
    ]);
    const serving = await serve({ context, port: options.port ?? 0, assets: ASSETS });
    const result: UiResult = { url: serving.url, port: serving.port };
    const printer = context.printer;
    if (printer.format === "json") {
      printer.json({ ok: true, data: result });
    } else {
      printer.info(`Serving the console at ${serving.url}`);
      printer.hint("The address carries a token for this session. Press Ctrl+C to stop.");
    }
    if (options["no-open"] !== true) open(serving.url);

    await stopped();
    await serving.close();
    return STREAMED;
  },
  // run prints as it starts and then serves, so there is nothing left to print.
  text() {},
});

function stopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}
