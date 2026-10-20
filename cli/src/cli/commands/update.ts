import { isReadOnlyLayout } from "#adapter/layouts/ids.ts";
import { satisfies } from "#adapter/semver.ts";
import { list } from "#adapter/text.ts";
import { rowsNamed } from "#cli/names.ts";
import { parse } from "#cli/options.ts";
import { cancel, confirmIfDestructive, interaction } from "#cli/prompt/flow.ts";
import { defaultIo } from "#cli/prompt/index.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { outcome, planReport, summarize, whoNeeds } from "#cli/render/plan.ts";
import { type Head, head } from "#cli/upstream.ts";
import { asksFor } from "#core/manifest.ts";
import { lockView } from "#core/plan/acquire.ts";
import { movesWithin } from "#core/plan/depends.ts";
import { listedAt } from "#core/plan/model.ts";
import { formatRef, type Ref, refName } from "#core/ref.ts";
import { olderThan } from "#core/semver.ts";
import { type Loaded, load, run as runPipeline } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/**
 * A range holds an artifact back from what is published outside it, as a pin holds it at one
 * version, so a newer version there is said the same way. A registry that cannot be asked says
 * nothing here; `aireg outdated` names why.
 */
async function outsideRanges(
  context: CommandContext,
  loaded: Loaded,
  ranged: readonly Ref[],
): Promise<void> {
  const lock = loaded.lock;
  const view = lockView(lock);
  const heads = new Map<string, Head>();
  for (const ref of ranged) {
    for (const key of view.reached(ref)) {
      const row = lock.artifacts[key];
      if (row?.version === undefined) continue;
      let found = heads.get(row.registry);
      if (found === undefined) {
        found = await head(row.registry, loaded.manifest, lock, loaded.roots.base);
        heads.set(row.registry, found);
      }
      const listed = listedAt(row, found.entries);
      const latest = listed === undefined ? undefined : found.byAddress.get(listed)?.version;
      if (latest === undefined || !olderThan(row.version, latest)) continue;
      if (satisfies(latest, ref.range as string)) continue;
      const address = formatRef(ref).replace(/@.*$/, "");
      context.printer.warning(
        `${refName(ref)} stays in ${ref.range}, set by ${formatRef(ref)}, though ${latest} is published.`,
      );
      context.printer.hint(
        `Move the range with \`aireg add ${address}@<range>\`, or drop it with \`aireg add ${address}\`.`,
      );
    }
  }
}

/**
 * The one command that moves locked versions: the rows it names, or every row,
 * resolve again. A version the manifest pinned survives, and a range is never left, so
 * both are reported.
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
  const ranged = loaded.manifest.artifacts.filter(
    (ref) =>
      ref.range !== undefined &&
      (named.size === 0 ||
        named.has(ref.registry) ||
        view.reached(ref).some((key) => named.has(key))),
  );
  if (ranged.length > 0) await outsideRanges(context, loaded, ranged);
  // A dependency is at the version its dependents name, so it moves only when they do, or within
  // the ranges they give.
  for (const name of named) {
    const row = lock.artifacts[name];
    if (row?.neededBy === undefined || asksFor(loaded.manifest, row)) continue;
    if (movesWithin(lock, name) !== undefined) continue;
    // Read at one commit, a source that is not a registry moves it with its dependents.
    if (isReadOnlyLayout(lock.registries[row.registry]?.config.layout)) continue;
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
          harnesses: fresh.harnesses,
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
