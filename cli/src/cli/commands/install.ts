import { INSTALL_COMMAND } from "#cli/commands/install/spec.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { confirmIfDestructive } from "#cli/prompt/confirm-plan.ts";
import { cancel, interaction } from "#cli/prompt/interaction.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, summarize } from "#cli/render/plan.ts";
import { run as runPipeline } from "#engine/install/pipeline.ts";
import { load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, INSTALL_COMMAND);
  noArguments(positionals, "install", "Run `aireg add <name>` to install something new.");
  const step = interaction(context.printer, defaultIo(), common.yes);
  const loaded = await load(common, context.cwd);

  let approved = true;
  const result = await runPipeline(
    loaded.roots,
    common,
    context.printer,
    context.cwd,
    planReport(context.printer),
    () => ({
      approve: async (plan, targets) => {
        approved = await confirmIfDestructive(step, plan, {
          verb: "Update",
          targets,
          targetTable: loaded.targetTable,
        });
        return approved;
      },
    }),
  );

  if (!approved) {
    cancel(step);
    return;
  }

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: { ...outcome(result, common.dryRun), unchanged: result.plan.unchanged },
    });
  } else if (result.applied) {
    summarize(context.printer, { ...result, applied: result.applied });
  }
  settleCollisions(context, result.plan);
}
