import { list, sanitizeName } from "#adapter/text.ts";
import type { RemoveResult } from "#cli/commands/remove/result.ts";
import { REMOVE_COMMAND } from "#cli/commands/remove/spec.ts";
import { needsInput, type Parsed, parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { chooseRemovals } from "#cli/prompt/choose.ts";
import { confirmPlan } from "#cli/prompt/confirm-plan.ts";
import { cancel, interaction, interactive, preparing, silence } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { exitOnClash, reportCollisions } from "#cli/render/collisions.ts";
import { planReport, type Ran, summarize, whoNeeds } from "#cli/render/plan.ts";
import { loadedBy, toolName } from "#cli/render/tools.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { dict } from "#core/fields.ts";
import type { Lock } from "#core/lock.ts";
import { reaches } from "#core/manifest/match.ts";
import type { Plan } from "#core/plan/model.ts";
import { editedAnywhere, survey } from "#core/plan/survey.ts";
import { formatAddress, parseRef, type Ref, relativeTo, withExclusions } from "#core/ref.ts";
import { type Roots, scopeName } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { runPipeline } from "#engine/install/pipeline.ts";
import { selectTargets } from "#engine/install/targets.ts";
import { matchInstalled, rowsNamed, shownNames } from "#engine/installed-names.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";
import { defineCommand, STREAMED } from "./define.ts";

type Options = Omit<Parsed<unknown>, "own">;

interface Removed {
  data: RemoveResult;
  said: Said;
}

interface Said {
  /** Kept for a job that publishes them, by the names `aireg list` shows. */
  watched: string[];
  needed: { name: string; by: string[] }[];
  /** Absent for a dry run, whose plan was shown as it ran. */
  ran: Ran | undefined;
  told: ReadonlySet<string>;
  plan: Plan;
}

export const { run } = defineCommand({
  spec: REMOVE_COMMAND,
  parse(argv): Options {
    const { positionals, common } = parse(argv, REMOVE_COMMAND);
    return { positionals, common };
  },
  run: remove,
  data: (result) => result.data,
  text({ said }, printer) {
    keptWatched(printer, said.watched);
    // A removal refused for a dependent is said as such, never as an update.
    for (const { name, by } of said.needed) {
      printer.warning(`Kept ${name}: ${whoNeeds(by)} it.`);
      printer.hint(
        `Remove ${list(by)} too, and ${name} goes with ${by.length === 1 ? "it" : "them"}.`,
      );
    }
    if (said.ran !== undefined) summarize(printer, said.ran, said.told);
    reportCollisions(printer, said.plan);
  },
});

async function remove(
  { positionals, common }: Options,
  context: CommandContext,
): Promise<Removed | typeof STREAMED> {
  const named = [...positionals, ...(common.select ?? [])].filter((name) => name !== "*");
  const removeAll = common.all || common.select?.includes("*") === true;

  const step = interaction(context.printer, defaultIo(), common.yes);
  if (named.length === 0 && !removeAll) preparing(step);
  const loaded = await load(common, context.cwd);

  let names = named;
  if (names.length === 0 && !removeAll) {
    const picked = await pickRemovals(step, loaded, common);
    if (picked === undefined) {
      cancel(step);
      return STREAMED;
    }
    names = picked;
  }

  let dropped: string[] = [];
  let asked: string[] = [];
  let approved = true;
  // --force here deletes the named edits; it must not also restore every other edited copy.
  const scoped = { ...common, force: false };
  const result = await runPipeline({
    roots: loaded.roots,
    common: scoped,
    printer: context.printer,
    cwd: context.cwd,
    report: planReport(context.printer),
    edit: async (fresh) => {
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
      asked = fresh.manifest.artifacts.flatMap((ref) => ref.targets ?? []);
      fresh.manifest.artifacts = fresh.manifest.artifacts.flatMap((ref) =>
        without(ref, drop, lock, removeAll || wholes.has(formatAddress(ref))),
      );

      const touched = [...new Set(dropped.map((key) => lock.artifacts[key]?.registry ?? ""))];
      return {
        ...(removeAll ? {} : { aliases: touched.filter((alias) => alias !== "") }),
        held: true,
        discard: new Set(edited),
      };
    },
    approve: async (plan, chosen) => {
      approved = await confirmPlan(step, plan, { verb: "Remove", ...chosen });
      return approved;
    },
  });

  if (!approved) {
    cancel(step);
    return STREAMED;
  }

  // An artifact something else depends on leaves the manifest but stays installed while needed.
  const record = result.plan.actions.find((action) => action.kind === "record");
  const needed = (name: string) => record?.lock.artifacts[name]?.neededBy;
  // What was named is removed, not pruned, even when something in a cycle needed it.
  const removing = new Set(dropped);
  const plan = { ...result.plan, pruned: result.plan.pruned.filter((name) => !removing.has(name)) };
  // A folder a job publishes is yours, and the job goes on reading it, so its row stays.
  const watched = dropped.filter((name) => record?.lock.artifacts[name]?.origin !== undefined);
  exitOnClash(context, plan);
  const needing = dropped.flatMap((name) => {
    const by = needed(name);
    return by === undefined ? [] : [{ name, by }];
  });
  const told = new Set([...needing.map(({ name }) => name), ...watched]);
  // A dropped entry takes the tools it named out of the manifest, yet those tools still reload.
  const targets = [
    ...new Set([...result.targets, ...asked.filter((name) => name in result.targetTable)]),
  ];
  const shown = shownNames(loaded.lock);
  return {
    data: {
      dryRun: common.dryRun,
      removed: dropped.filter((name) => needed(name) === undefined && !watched.includes(name)),
      pruned: plan.pruned,
      watched,
    },
    said: {
      watched: watched.map((name) => shown.get(name) ?? name),
      needed: needing,
      ran: result.applied ? { ...result, targets, plan, applied: result.applied } : undefined,
      told,
      plan,
    },
  };
}

async function pickRemovals(
  step: ReturnType<typeof interaction>,
  loaded: Loaded,
  common: CommonOptions,
): Promise<string[] | undefined> {
  const installed = new Set(Object.keys(loaded.lock.artifacts));
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
    throw needsInput(
      "remove",
      "an artifact name",
      `Name one: \`aireg remove <name>\`, or pass \`--all\`. No list was offered because ${silence(step)}.`,
    );
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
          loaded.targetTable,
          selectTargets(loaded.manifest, loaded.targetTable, common),
          entry?.kind,
          (entry?.links ?? []).map((linked) => linked.target),
        ).map((name) => toolName(loaded.targetTable, name)),
      };
    }),
  );
  return canceled(picked) ? undefined : picked;
}

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

/**
 * A ref naming a dropped artifact goes, as does a whole ref removed by its own address;
 * any other keeps the rest minus what was dropped, so later members still arrive.
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

/** Said whenever a removal leaves a row a job publishes, so it is never kept silently. */
function keptWatched(printer: Printer, watched: readonly string[]): void {
  if (watched.length === 0) return;
  printer.warning(
    `Kept ${list(watched)}, which a job publishes from your own ${watched.length === 1 ? "folder" : "folders"}.`,
  );
  printer.hint(
    "Run `aireg watch list` to see the folder, and `aireg watch remove <folder>` to stop publishing it.",
  );
}
