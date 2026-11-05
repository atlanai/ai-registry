import type { InstallResult } from "#cli/commands/install/result.ts";
import { INSTALL_COMMAND } from "#cli/commands/install/spec.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { confirmIfDestructive } from "#cli/prompt/confirm-plan.ts";
import { cancel, interaction } from "#cli/prompt/interaction.ts";
import { exitOnClash, reportCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, summarize } from "#cli/render/plan.ts";
import { type RunResult, runPipeline } from "#engine/install/pipeline.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { defineCommand, STREAMED } from "./define.ts";

interface Installed {
  data: InstallResult;
  ran: RunResult;
}

export const { run } = defineCommand({
  spec: INSTALL_COMMAND,
  parse(argv): CommonOptions {
    const { positionals, common } = parse(argv, INSTALL_COMMAND);
    noArguments(positionals, "install", "Run `aireg add <name>` to install something new.");
    return common;
  },
  async run(common, context): Promise<Installed | typeof STREAMED> {
    const step = interaction(context.printer, defaultIo(), common.yes);
    const loaded = await load(common, context.cwd);

    let approved = true;
    const result = await runPipeline({
      roots: loaded.roots,
      common,
      printer: context.printer,
      cwd: context.cwd,
      report: planReport(context.printer),
      approve: async (plan, chosen) => {
        approved = await confirmIfDestructive(step, plan, { verb: "Update", ...chosen });
        return approved;
      },
    });

    if (!approved) {
      cancel(step);
      return STREAMED;
    }
    exitOnClash(context, result.plan);
    return {
      data: { ...outcome(result, common.dryRun), unchanged: result.plan.unchanged },
      ran: result,
    };
  },
  data: (result) => result.data,
  text({ ran }, printer) {
    if (ran.applied) summarize(printer, { ...ran, applied: ran.applied });
    reportCollisions(printer, ran.plan);
  },
});
