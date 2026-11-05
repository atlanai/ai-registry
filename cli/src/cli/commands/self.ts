import { SELF_COMMAND } from "#cli/commands/self/spec.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type CommandContext, runAction } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const at = context.argv.findIndex((arg) => !arg.startsWith("-"));
  const action = at === -1 ? undefined : context.argv[at];
  if (action === undefined) {
    throw new AiregError("`aireg self` needs an action.", {
      code: ErrorCode.Usage,
      hint: "Run `aireg self update` or `aireg self uninstall`.",
    });
  }
  const argv = context.argv.filter((_, index) => index !== at);
  const handed = { ...context, argv };
  return runAction(SELF_COMMAND, action, {
    update: async () => (await import("#cli/commands/self/update.ts")).run(handed),
    uninstall: async () => (await import("#cli/commands/self/uninstall.ts")).run(handed),
  });
}
