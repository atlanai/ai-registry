import { addAddress } from "#cli/commands/add/from-address.ts";
import { addFrom } from "#cli/commands/add/from-lock.ts";
import type { AddFlags, Parsed } from "#cli/commands/add/options.ts";
import { printAdded, reportAdded } from "#cli/commands/add/render.ts";
import { ADD_COMMAND } from "#cli/commands/add/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { defineCommand, STREAMED } from "./define.ts";

export const { run } = defineCommand({
  spec: ADD_COMMAND,
  parse(argv): Parsed {
    const parsed = parse<AddFlags>(argv, ADD_COMMAND);
    const { positionals, common, own } = parsed;
    if (
      own.from !== undefined &&
      (positionals.length > 0 || own.registry !== undefined || common.select !== undefined)
    ) {
      throw new AiregError("`aireg add --from` takes no address and no -s.", {
        code: ErrorCode.Usage,
        hint: "Run `aireg add --from <file>` on its own: the file says what to add.",
      });
    }
    return parsed;
  },
  async run(parsed, context) {
    if (parsed.own.from !== undefined) {
      await addFrom(context, parsed, parsed.own.from);
      return STREAMED;
    }
    const added = await addAddress(context, parsed);
    if (added === undefined) return STREAMED;
    // Under `--json`, warnings and hints still go to stderr.
    if (context.printer.format === "json") reportAdded(context.printer, added.said);
    return added;
  },
  data: (added) => added.data,
  text: (added, printer) => printAdded(printer, added),
});
