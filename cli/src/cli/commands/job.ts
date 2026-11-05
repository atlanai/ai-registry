import { addJob } from "#cli/commands/job/add.ts";
import { list } from "#cli/commands/job/list.ts";
import type { JobOptions, Own } from "#cli/commands/job/options.ts";
import { remove } from "#cli/commands/job/remove.ts";
import { cancel, retry, runs } from "#cli/commands/job/runs.ts";
import { JOB_COMMAND } from "#cli/commands/job/spec.ts";
import { start } from "#cli/commands/job/start.ts";
import { disable, enable, pause, resume } from "#cli/commands/job/toggle.ts";
import { parse } from "#cli/options/parse.ts";
import type { FlagSpec } from "#core/host/extend.ts";
import { contributedStepFlags } from "#core/host/load.ts";
import type { CommandContext } from "./command.ts";
import { defineCommand } from "./define.ts";

export async function run(context: CommandContext): Promise<void> {
  // An adapter's job type adds its own flags, which parsing must know before it reads argv.
  return jobCommand(await contributedStepFlags()).run(context);
}

function jobCommand(extra: Readonly<Record<string, FlagSpec>>) {
  return defineCommand<JobOptions>({
    spec: JOB_COMMAND,
    parse(argv) {
      const { positionals, own, common } = parse<Own>(argv, JOB_COMMAND, extra);
      const [action = "list", argument] = positionals;
      return { action, options: { argument, own, common } };
    },
    actions: {
      list,
      add: addJob,
      remove,
      start,
      enable,
      disable,
      pause,
      resume,
      runs,
      retry,
      cancel,
    },
  });
}
