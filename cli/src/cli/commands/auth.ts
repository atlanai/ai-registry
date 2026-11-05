import { list as listOf } from "#adapter/text.ts";
import { list, printList } from "#cli/commands/auth/list.ts";
import { type LoginFlags, login, loginData, printLogin } from "#cli/commands/auth/login.ts";
import { LOGOUT_OR_REMOVE, logout, remove } from "#cli/commands/auth/logout.ts";
import type { AuthAccountId } from "#cli/commands/auth/result.ts";
import { AUTH_COMMAND } from "#cli/commands/auth/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { unknownAction } from "#cli/options/suggest.ts";
import { action, defineCommand } from "./define.ts";

interface Options {
  argument: string | undefined;
  flags: LoginFlags;
  yes: boolean;
}

export const { run } = defineCommand<Options>({
  spec: AUTH_COMMAND,
  parse(argv) {
    const { positionals, own, common } = parse<LoginFlags & Record<string, unknown>>(
      argv,
      AUTH_COMMAND,
    );
    const [verb = "list", argument] = positionals;
    refuseUnknown(verb);
    return { action: verb, options: { argument, flags: own, yes: common.yes } };
  },
  actions: {
    list: action({ run: () => list(), text: printList }),
    login: action({
      run: ({ argument, flags, yes }, context) => login(context, argument, flags, yes),
      text: printLogin,
      data: loginData,
    }),
    logout: action({
      run: ({ argument }) => logout(argument),
      text: (result, printer) =>
        printer.success(`Signed out of ${result.registry}, keeping the account for its jobs.`),
      data: ({ accountId }): AuthAccountId => ({ accountId }),
    }),
    remove: action({
      run: ({ argument }) => remove(argument),
      text: (result, printer) => printer.success(`Removed the account for ${result.registry}.`),
      data: ({ accountId }): AuthAccountId => ({ accountId }),
    }),
  },
});

/** Refused here rather than by dispatch, so the hint can tell logout from remove. */
function refuseUnknown(verb: string): void {
  const names = (AUTH_COMMAND.actions ?? []).map((known) => known.name);
  if (names.includes(verb)) return;
  throw unknownAction(
    AUTH_COMMAND.name,
    verb,
    names,
    `Use ${listOf(names, "or")}. ${LOGOUT_OR_REMOVE}`,
  );
}
