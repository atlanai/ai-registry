import { add } from "#cli/commands/registry/add.ts";
import { index } from "#cli/commands/registry/build-index.ts";
import { init } from "#cli/commands/registry/init.ts";
import { list } from "#cli/commands/registry/list.ts";
import type { Flags, Options } from "#cli/commands/registry/options.ts";
import { remove } from "#cli/commands/registry/remove.ts";
import { show } from "#cli/commands/registry/show.ts";
import { REGISTRY_COMMAND } from "#cli/commands/registry/spec.ts";
import { validate } from "#cli/commands/registry/validate.ts";
import { parse } from "#cli/options/parse.ts";
import { defineCommand } from "./define.ts";

export const { run } = defineCommand<Options>({
  spec: REGISTRY_COMMAND,
  parse(argv) {
    const { positionals, common, own } = parse<Flags>(argv, REGISTRY_COMMAND);
    const [action = "list", argument] = positionals;
    return { action, options: { argument, flags: own, common } };
  },
  actions: { add, init, index, validate, list, show, remove },
});
