import { add } from "#cli/commands/registry/add.ts";
import { index } from "#cli/commands/registry/build-index.ts";
import { init } from "#cli/commands/registry/init.ts";
import { list } from "#cli/commands/registry/list.ts";
import type { Flags } from "#cli/commands/registry/options.ts";
import { remove } from "#cli/commands/registry/remove.ts";
import { show } from "#cli/commands/registry/show.ts";
import { REGISTRY_COMMAND } from "#cli/commands/registry/spec.ts";
import { validate } from "#cli/commands/registry/validate.ts";
import { parse } from "#cli/options/parse.ts";
import { type CommandContext, runAction } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const spec = REGISTRY_COMMAND;
  const { positionals, common, own } = parse<Flags>(context.argv, spec);
  const [action = "list", argument] = positionals;
  return runAction(spec, action, {
    add: () => add(context, argument, own, common),
    init: () => init(context, argument, own, common),
    index: () => index(context, argument),
    validate: () => validate(context, argument, own.base),
    list: () => list(context, common),
    show: () => show(context, argument, own, common),
    remove: () => remove(context, argument, common),
  });
}
