import { addAddress } from "#cli/commands/add/from-address.ts";
import { addFrom } from "#cli/commands/add/from-lock.ts";
import type { AddFlags } from "#cli/commands/add/options.ts";
import { ADD_COMMAND } from "#cli/commands/add/spec.ts";
import { parse } from "#cli/options/parse.ts";
import type { CommandContext } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const parsed = parse<AddFlags>(context.argv, ADD_COMMAND);
  if (parsed.own.from !== undefined) return addFrom(context, parsed, parsed.own.from);
  return addAddress(context, parsed);
}
