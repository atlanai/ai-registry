import { isReadOnlyLayout, type LayoutId } from "#adapter/layouts/ids.ts";
import { withoutCredentials } from "#adapter/text.ts";
import type { AddResult } from "#cli/commands/add/result.ts";
import { reportCollisions } from "#cli/render/collisions.ts";
import { outcome, type Ran, summarize } from "#cli/render/plan.ts";
import { noteUserScope } from "#cli/render/where.ts";
import type { Plan } from "#core/plan/model.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import type { Probed } from "#engine/address/probe.ts";
import type { RunResult } from "#engine/install/pipeline.ts";
import type { Repin } from "./declare.ts";
import { type Kept, printKept } from "./keep-current.ts";

export interface Added {
  data: AddResult;
  said: Said;
}

interface Said {
  plan: Plan;
  /** Absent for a dry run. */
  applied: AppliedAdd | undefined;
  kept: Kept | undefined;
  where: { asked: Scope | undefined; cwd: string } | undefined;
  /** The non-interactive command that repeats an interactive add. */
  equivalent: string | undefined;
}

interface AppliedAdd {
  alias: string;
  source: Probed;
  location: string;
  /** Named with `--as`. */
  named: boolean;
  introduced: boolean;
  copied: boolean;
  repinned: readonly Repin[];
  ran: Ran;
}

export function addedData(
  added: {
    registry: string;
    layout: LayoutId | undefined;
    artifacts: readonly string[];
    jobId: string | undefined;
  },
  result: RunResult,
  dryRun: boolean,
): AddResult {
  const { registry, layout, artifacts, jobId } = added;
  return {
    registry,
    artifacts: [...artifacts],
    ...(layout !== undefined && isReadOnlyLayout(layout) ? { layout } : {}),
    dependencies: result.plan.neededBy,
    ...outcome(result, dryRun),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

export function emitAdded(printer: Printer, added: Added): void {
  if (printer.format !== "json") {
    printAdded(printer, added);
    return;
  }
  reportAdded(printer, added.said);
  printer.json({ ok: true, data: added.data });
}

export function printAdded(printer: Printer, { said }: Added): void {
  reportAdded(printer, said);
  if (said.where !== undefined) noteUserScope(printer, said.where.asked, said.where.cwd);
  if (said.equivalent !== undefined) printer.info(printer.style.dim(`  ${said.equivalent}`));
}

/** Under `--json`, only warnings and hints print. */
export function reportAdded(printer: Printer, said: Said): void {
  const { applied } = said;
  if (applied === undefined) {
    reportCollisions(printer, said.plan);
    return;
  }
  const { alias, source } = applied;
  if (applied.introduced) {
    printer.success(`Added registry ${alias} at ${withoutCredentials(applied.location)}.`);
    if (source.label !== undefined) printer.note("about", source.label);
    if (!applied.named && source.named === "address") {
      printer.note("named", "after its address; choose another with --as");
    }
  }
  if (applied.copied) printer.success(`Added registry ${alias} to this project's manifest.`);
  for (const { name, version } of applied.repinned) {
    printer.success(version === undefined ? `Unpinned ${name}.` : `Pinned ${name} at ${version}.`);
  }
  // A pin that moved nothing is said once, by the line above, rather than as "Already up to date".
  const acted = new Set(
    applied.ran.plan.actions.flatMap((action) => ("name" in action ? [action.name] : [])),
  );
  const told = applied.repinned.map((item) => item.name).filter((name) => !acted.has(name));
  summarize(printer, applied.ran, new Set(told));
  reportCollisions(printer, applied.ran.plan);
  if (said.kept !== undefined) printKept(printer, said.kept);
}
