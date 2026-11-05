import { list } from "#cli/commands/auth/list.ts";
import { type LoginFlags, login } from "#cli/commands/auth/login.ts";
import { LOGOUT_OR_REMOVE, logout, remove } from "#cli/commands/auth/logout.ts";
import { AUTH_COMMAND } from "#cli/commands/auth/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { type CommandContext, runAction } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const spec = AUTH_COMMAND;
  const { positionals, own, common } = parse<LoginFlags & Record<string, unknown>>(
    context.argv,
    spec,
  );
  const [action = "list", argument] = positionals;
  return runAction(
    spec,
    action,
    {
      list: () => list(context),
      login: () => login(context, argument, own, common.yes),
      logout: () => logout(context, argument),
      remove: () => remove(context, argument),
    },
    LOGOUT_OR_REMOVE,
  );
}
