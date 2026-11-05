import { quoted } from "#adapter/text.ts";
import { SELF_COMMAND } from "#cli/commands/self/spec.ts";
import { printUninstall, uninstall } from "#cli/commands/self/uninstall.ts";
import { printUpdate, update } from "#cli/commands/self/update.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { actionOf } from "./command.ts";
import { action, defineCommand } from "./define.ts";

interface Options {
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  check: boolean;
  rollback: boolean;
}

const UNPARSED: Options = {
  dryRun: false,
  force: false,
  yes: false,
  check: false,
  rollback: false,
};

export const { run } = defineCommand<Options>({
  spec: SELF_COMMAND,
  parse(argv) {
    const at = argv.findIndex((arg) => !arg.startsWith("-"));
    const named = at === -1 ? undefined : argv[at];
    if (named === undefined) {
      throw needsInput("self", "an action", "Run `aireg self update` or `aireg self uninstall`.");
    }
    return { action: named, options: optionsOf(named, argv.toSpliced(at, 1)) };
  },
  actions: {
    update: action({ run: (options) => update(options), text: printUpdate }),
    uninstall: action({
      run: (options, context) => uninstall(options, context),
      text: printUninstall,
    }),
  },
});

/** Each action checks only its own options, so an unknown one is refused by name. */
function optionsOf(named: string, argv: string[]): Options {
  if (named === "update") {
    const { common, own } = parse<{ check?: boolean; rollback?: boolean }>(
      argv,
      actionOf(SELF_COMMAND, "update"),
    );
    return {
      ...UNPARSED,
      dryRun: common.dryRun,
      force: common.force,
      check: own.check === true,
      rollback: own.rollback === true,
    };
  }
  if (named === "uninstall") {
    const { common, positionals } = parse(argv, actionOf(SELF_COMMAND, "uninstall"));
    if (positionals.length > 0) {
      throw new AiregError(
        `\`aireg self uninstall\` takes no argument, not ${quoted(positionals[0] as string)}.`,
        {
          code: ErrorCode.Usage,
          hint: "Run `aireg self uninstall --dry-run` to see what it removes.",
        },
      );
    }
    return { ...UNPARSED, dryRun: common.dryRun, yes: common.yes };
  }
  return UNPARSED;
}
