import { list } from "#adapter/text.ts";
import { rowsNamed } from "#cli/names.ts";
import { parse } from "#cli/options.ts";
import { cancel, confirmIfDestructive, interaction } from "#cli/prompt/flow.ts";
import { defaultIo } from "#cli/prompt/index.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, summarize, whoNeeds } from "#cli/render/plan.ts";
import { asksFor } from "#core/manifest.ts";
import { lockView } from "#core/plan/acquire.ts";
import { formatRef, refName } from "#core/ref.ts";
import { load, run as runPipeline } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/**
 * The one command that moves locked versions: the rows it names, or every row,
 * resolve again. A version the manifest pinned survives, so it is reported.
 */
export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("update"));
  const step = interaction(context.printer, defaultIo(), common.yes);
  const loaded = await load(common, context.cwd);

  const lock = loaded.lock;
  // A registry's name, or any name `aireg list` accepts for an installed artifact.
  const named = new Set(
    positionals.flatMap((name) =>
      lock.registries[name] !== undefined ? [name] : rowsNamed(name, lock),
    ),
  );

  // Named explicitly and held at a version: the command cannot do what it looks
  // like it did, so it says which reference is holding it and how to move it.
  const view = lockView(lock);
  const held = loaded.manifest.artifacts.filter(
    (ref) =>
      ref.version !== undefined &&
      (named.size === 0 || view.reached(ref).some((key) => named.has(key))),
  );
  for (const ref of held) {
    const address = formatRef(ref).replace(/@.*$/, "");
    context.printer.warning(
      `${refName(ref)} stays at ${ref.version}, pinned by ${formatRef(ref)}.`,
    );
    const needing = view.reached(ref).flatMap((key) => lock.artifacts[key]?.neededBy ?? []);
    context.printer.hint(
      needing.length > 0
        ? `Release a version of ${list([...new Set(needing)])} that needs another version of ${refName(ref)}, then move the pin with \`aireg add ${address}@<version>\`.`
        : `Move it with \`aireg add ${address}@<version>\`, or drop the pin with \`aireg add ${address}\`.`,
    );
  }
  // A dependency is at the version its dependents name, so it moves only when they do.
  for (const name of named) {
    const row = lock.artifacts[name];
    if (row?.neededBy === undefined || asksFor(loaded.manifest, row)) continue;
    context.printer.warning(
      `${name} stays at ${row.version}, because ${whoNeeds(row.neededBy)} that version.`,
    );
  }

  let approved = true;
  const result = await runPipeline(
    loaded.roots,
    common,
    context.printer,
    context.cwd,
    planReport(context.printer),
    (fresh) => ({
      refresh: true,
      moving: new Set(
        Object.entries(fresh.lock.artifacts)
          .filter(([name, row]) => named.size === 0 || named.has(name) || named.has(row.registry))
          .map(([name]) => name),
      ),
      approve: async (plan, targets) => {
        approved = await confirmIfDestructive(step, plan, {
          verb: "Update",
          targets,
          targetTable: fresh.targetTable,
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
    context.printer.json({ ok: true, data: outcome(result, common.dryRun) });
  } else if (result.applied) {
    summarize(context.printer, { ...result, applied: result.applied });
  }
  settleCollisions(context, result.plan);
}
