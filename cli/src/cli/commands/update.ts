import { list } from "#adapter/text.ts";
import type { UpdateResult } from "#cli/commands/update/result.ts";
import { UPDATE_COMMAND } from "#cli/commands/update/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { confirmIfDestructive } from "#cli/prompt/confirm-plan.ts";
import { cancel, interaction } from "#cli/prompt/interaction.ts";
import { exitOnClash, reportCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, summarize, whoNeeds } from "#cli/render/plan.ts";
import { asksFor } from "#core/manifest/match.ts";
import { lockView } from "#core/plan/acquire/lock-view.ts";
import { formatRef, refName } from "#core/ref.ts";
import { type RunResult, run as runPipeline } from "#engine/install/pipeline.ts";
import { rowsNamed } from "#engine/installed-names.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";
import { defineCommand, STREAMED } from "./define.ts";

interface Options {
  positionals: string[];
  common: CommonOptions;
}

interface Updated {
  data: UpdateResult;
  ran: RunResult;
}

/**
 * The one command that moves locked versions: the rows it names, or every row,
 * resolve again. A version the manifest pinned survives, so it is reported.
 */
export const { run } = defineCommand({
  spec: UPDATE_COMMAND,
  parse(argv): Options {
    const { positionals, common } = parse(argv, UPDATE_COMMAND);
    return { positionals, common };
  },
  run: update,
  data: (result) => result.data,
  text({ ran }, printer) {
    if (ran.applied) summarize(printer, { ...ran, applied: ran.applied });
    reportCollisions(printer, ran.plan);
  },
});

async function update(
  { positionals, common }: Options,
  context: CommandContext,
): Promise<Updated | typeof STREAMED> {
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
    return STREAMED;
  }
  exitOnClash(context, result.plan);
  return { data: outcome(result, common.dryRun), ran: result };
}
