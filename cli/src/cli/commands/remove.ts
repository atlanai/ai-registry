import { list, sanitizeName } from "#adapter/text.ts";
import { matchInstalled, rowsNamed, shownNames } from "#cli/names.ts";
import { parse } from "#cli/options.ts";
import {
  cancel,
  chooseRemovals,
  confirmPlan,
  interaction,
  interactive,
  preparing,
  silence,
} from "#cli/prompt/flow.ts";
import { canceled, defaultIo } from "#cli/prompt/index.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { planReport, summarize, whoNeeds } from "#cli/render/plan.ts";
import { loadedBy, toolName } from "#cli/render/tools.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { dict } from "#core/fields.ts";
import type { Lock } from "#core/lock.ts";
import { reaches } from "#core/manifest.ts";
import { editedAnywhere } from "#core/plan/model.ts";
import { survey } from "#core/plan/survey.ts";
import { formatAddress, parseRef, type Ref, relativeTo, withExclusions } from "#core/ref.ts";
import { type Roots, scopeName } from "#core/store/paths.ts";
import { load, resolveTargets, run as runPipeline } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/**
 * A ref naming a dropped artifact goes, as does a whole ref removed by its own address;
 * any other keeps taking the rest minus what was dropped, so later members still arrive.
 */
function without(ref: Ref, drop: ReadonlySet<string>, lock: Lock, whole: boolean): Ref[] {
  const covered = Object.entries(lock.artifacts).filter(([, entry]) => reaches(ref, entry));
  const dropped = covered.filter(([key]) => drop.has(key));
  // Checked first: a namespace whose every member was already removed covers nothing.
  if (whole && dropped.length === covered.length) return [];
  if (dropped.length === 0) return [ref];
  if (ref.name !== undefined) return [];
  const exclusions = dropped.map(([, entry]) =>
    relativeTo(ref, {
      namespace: entry.namespace,
      kind: entry.kind,
      name: sanitizeName(entry.name),
    }),
  );
  return [withExclusions(ref, [...(ref.exclude ?? []), ...exclusions])];
}

/** A name written as a whole registry or namespace's address, such as `acme/frontend`. */
function wholeAddress(name: string): string[] {
  try {
    const ref = parseRef(name);
    return ref.name === undefined ? [formatAddress(ref)] : [];
  } catch {
    return [];
  }
}

async function editedAmong(lock: Lock, names: readonly string[], roots: Roots): Promise<string[]> {
  const wanted = new Set(names);
  const going = Object.entries(lock.artifacts).filter(([name]) => wanted.has(name));
  const found = await survey({ ...lock, artifacts: dict(going) }, roots);
  return names.filter((name) => editedAnywhere(lock.artifacts[name], found.artifacts[name]));
}

/** Said whenever a removal leaves a row a job publishes, so it is never kept silently. */
function keptWatched(context: CommandContext, lock: Lock, watched: readonly string[]): void {
  if (watched.length === 0) return;
  const shown = shownNames(lock);
  context.printer.warning(
    `Kept ${list(watched.map((name) => shown.get(name) ?? name))}, which a job publishes from your own ${watched.length === 1 ? "folder" : "folders"}.`,
  );
  context.printer.hint(
    "Run `aireg job list` to see the job, and `aireg job remove <job>` to stop it.",
  );
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("remove"));
  const named = [...positionals, ...(common.select ?? [])].filter((name) => name !== "*");
  const removeAll = common.all || common.select?.includes("*") === true;

  const step = interaction(context.printer, defaultIo(), common.yes);
  if (named.length === 0 && !removeAll) preparing(step);
  const loaded = await load(common, context.cwd);
  const lock = loaded.lock;
  const installed = new Set(Object.keys(lock.artifacts));

  let names = named;
  if (names.length === 0 && !removeAll) {
    if (installed.size === 0) {
      throw new AiregError(`Nothing is installed in ${scopeName(loaded.roots.scope)}.`, {
        code: ErrorCode.NotFound,
        hint:
          loaded.roots.scope === "user"
            ? "Run `aireg list` in a project to see what it installs."
            : "Run `aireg list -g` to see your user scope.",
      });
    }
    if (!interactive(step)) {
      // Name the reason: on a terminal this command would have offered a list,
      // and "nothing to remove" alone reads as though nothing is installed.
      throw new AiregError("`aireg remove` needs an artifact name.", {
        code: ErrorCode.Usage,
        hint: `Name one: \`aireg remove <name>\`, or pass \`--all\`. No list was offered because ${silence(step)}.`,
      });
    }
    const picked = await chooseRemovals(
      step,
      [...installed].sort().map((name) => {
        const entry = loaded.lock.artifacts[name];
        return {
          name,
          kind: entry?.kind ?? "",
          source: entry?.registry ?? "",
          targets: loadedBy(
            loaded.harnesses,
            resolveTargets(loaded.manifest, loaded.harnesses, common),
            entry?.kind,
            (entry?.links ?? []).map((linked) => linked.harness),
          ).map((name) => toolName(loaded.harnesses, name)),
        };
      }),
    );
    if (canceled(picked)) {
      cancel(step);
      return;
    }
    names = picked;
  }

  let dropped: string[] = [];
  let approved = true;
  // --force here deletes the named edits; it must not also restore every other edited copy.
  const scoped = { ...common, force: false };
  const result = await runPipeline(
    loaded.roots,
    scoped,
    context.printer,
    context.cwd,
    planReport(context.printer),
    async (fresh) => {
      const lock = fresh.lock;
      const declared = new Set(fresh.manifest.artifacts.map(formatAddress));
      // A namespace the manifest still takes is named even when nothing it covers is installed.
      const emptied = (name: string) =>
        wholeAddress(name).some((address) => declared.has(address)) &&
        matchInstalled(name, lock).rows.length === 0;
      dropped = removeAll
        ? Object.keys(lock.artifacts)
        : names.flatMap((name) => (emptied(name) ? [] : rowsNamed(name, lock)));
      const drop = new Set(dropped);
      const edited = await editedAmong(lock, dropped, fresh.roots);
      if (edited.length > 0 && !common.force && !interactive(step)) {
        throw new AiregError(
          `${list(edited)} ${edited.length === 1 ? "has" : "have"} local edits, so nothing was removed.`,
          {
            code: ErrorCode.Changed,
            hint: "Run `aireg sync --dry-run` to compare the edits with the registry, or pass `--force` to delete them.",
          },
        );
      }
      const wholes = new Set(names.flatMap(wholeAddress));
      fresh.manifest.artifacts = fresh.manifest.artifacts.flatMap((ref) =>
        without(ref, drop, lock, removeAll || wholes.has(formatAddress(ref))),
      );

      const touched = [...new Set(dropped.map((key) => lock.artifacts[key]?.registry ?? ""))];
      return {
        ...(removeAll ? {} : { aliases: touched.filter((alias) => alias !== "") }),
        held: true,
        discard: new Set(edited),
        approve: async (plan, targets) => {
          approved = await confirmPlan(step, plan, {
            verb: "Remove",
            targets,
            harnesses: fresh.harnesses,
          });
          return approved;
        },
      };
    },
  );

  if (!approved) {
    cancel(step);
    return;
  }

  // An artifact something else depends on leaves the manifest but stays
  // installed for as long as something needs it.
  const record = result.plan.actions.find((action) => action.kind === "record");
  const needed = (name: string) => record?.lock.artifacts[name]?.neededBy;
  // What was named is removed, not pruned, even when something in a cycle needed it.
  const removing = new Set(dropped);
  const plan = { ...result.plan, pruned: result.plan.pruned.filter((name) => !removing.has(name)) };
  // A folder a job publishes is yours, and the job goes on reading it, so its row stays.
  const watched = dropped.filter((name) => record?.lock.artifacts[name]?.origin !== undefined);
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        dryRun: common.dryRun,
        removed: dropped.filter((name) => needed(name) === undefined && !watched.includes(name)),
        pruned: plan.pruned,
        watched,
      },
    });
    settleCollisions(context, plan);
    return;
  }
  keptWatched(context, lock, watched);
  // A removal refused for a dependent is said as such, never as an update.
  const kept = new Set<string>();
  for (const name of dropped) {
    const by = needed(name);
    if (by === undefined) continue;
    kept.add(name);
    context.printer.warning(`Kept ${name}: ${whoNeeds(by)} it.`);
    context.printer.hint(
      `Remove ${list(by)} too, and ${name} goes with ${by.length === 1 ? "it" : "them"}.`,
    );
  }
  const told = new Set([...kept, ...watched]);
  if (result.applied)
    summarize(context.printer, { ...result, plan, applied: result.applied }, told);
  settleCollisions(context, plan);
}
