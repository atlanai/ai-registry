import { add } from "#cli/commands/job/add.ts";
import { list } from "#cli/commands/job/list.ts";
import type { Own } from "#cli/commands/job/options.ts";
import { JOB_COMMAND } from "#cli/commands/job/spec.ts";
import { start } from "#cli/commands/job/start.ts";
import { setEnabled, setPaused } from "#cli/commands/job/toggle.ts";
import { parse } from "#cli/options/parse.ts";
import { contributedStepFlags } from "#core/host/load.ts";
import { type CommandContext, runAction } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const extra = await contributedStepFlags();
  const spec = JOB_COMMAND;
  const { positionals, own, common } = parse<Own>(context.argv, spec, extra);
  const [action = "list", argument] = positionals;
  return runAction(spec, action, {
    list: () => list(context),
    add: () => add(context, argument, own, common),
    remove: async () => (await import("#cli/commands/job/remove.ts")).remove(context, argument),
    start: () => start(context, argument, own.mode),
    enable: () => setEnabled(context, argument, true),
    disable: () => setEnabled(context, argument, false),
    pause: () => setPaused(context, true, argument),
    resume: () => setPaused(context, false, argument),
    runs: async () => (await import("#cli/commands/job/runs.ts")).runs(context, argument, own),
    retry: async () => (await import("#cli/commands/job/runs.ts")).retry(context, argument),
    cancel: async () => (await import("#cli/commands/job/runs.ts")).cancel(context, argument),
  });
}
