import { isReadOnlyLayout, type LayoutId } from "#adapter/layouts/ids.ts";
import { withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { settleCollisions } from "#cli/render/collisions.ts";
import { outcome, type Ran, summarize } from "#cli/render/plan.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Probed } from "#engine/address/probe.ts";
import type { RunResult } from "#engine/install/pipeline.ts";
import type { Repin } from "./declare.ts";
import { keepCurrent } from "./keep-current.ts";

export function printAdded(
  context: CommandContext,
  added: {
    registry: string;
    layout: LayoutId | undefined;
    artifacts: readonly string[];
    jobId: string | undefined;
  },
  result: RunResult,
  dryRun: boolean,
): void {
  const { jobId, layout, ...named } = added;
  context.printer.json({
    ok: true,
    data: {
      ...named,
      ...(isReadOnlyLayout(layout) ? { layout } : {}),
      dependencies: result.plan.neededBy,
      ...outcome(result, dryRun),
      ...(jobId === undefined ? {} : { jobId }),
    },
  });
}

/**
 * What an applied add changed: the registry it introduced, then the plan's summary.
 * Returns the job that keeps a user scope install current, if there is one.
 */
export async function reportAdded(
  context: CommandContext,
  added: {
    alias: string;
    source: Probed;
    location: string;
    config: Readonly<Record<string, string>>;
    named: boolean;
    introduced: boolean;
    copied: boolean;
    repinned: readonly Repin[];
    ran: Ran;
    scope: Scope;
    autoUpdate: boolean;
    /** Every artifact named was pinned, so background updates leave it where it is. */
    pinned: boolean;
  },
): Promise<string | undefined> {
  const { printer } = context;
  const { alias, source } = added;
  if (added.introduced) {
    printer.success(`Added registry ${alias} at ${withoutCredentials(added.location)}.`);
    if (source.label !== undefined) printer.note("about", source.label);
    if (!added.named && source.named === "address") {
      printer.note("named", "after its address; choose another with --as");
    }
  }
  if (added.copied) printer.success(`Added registry ${alias} to this project's manifest.`);
  for (const { name, version } of added.repinned) {
    printer.success(version === undefined ? `Unpinned ${name}.` : `Pinned ${name} at ${version}.`);
  }
  // A pin that moved nothing is said once, by the line above, rather than as "Already up to date".
  const acted = new Set(
    added.ran.plan.actions.flatMap((action) => ("name" in action ? [action.name] : [])),
  );
  const said = added.repinned.map((item) => item.name).filter((name) => !acted.has(name));
  summarize(printer, added.ran, new Set(said));
  settleCollisions(context, added.ran.plan);
  if (added.scope === "user" && added.autoUpdate) {
    return keepCurrent(context, alias, added.config, added.pinned);
  }
  return undefined;
}
