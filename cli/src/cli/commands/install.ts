import { noArguments, parse } from "#cli/options.ts";
import { cancel, confirmIfDestructive, interaction } from "#cli/prompt/flow.ts";
import { defaultIo } from "#cli/prompt/index.ts";
import { outcome, planReport, summarize } from "#cli/render/plan.ts";
import { load, run as runPipeline } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("install"));
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
          harnesses: loaded.harnesses,
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
    return;
  }
  if (result.applied) summarize(context.printer, { ...result, applied: result.applied });
}
