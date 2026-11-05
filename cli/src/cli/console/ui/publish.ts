import * as commands from "#core/console/actions.ts";
import { publishable, selector } from "#core/console/artifacts.ts";
import type { Line } from "#core/console/flatten.ts";
import type { ArtifactRow, ConsoleState } from "#core/console/model.ts";
import type { UpstreamContribution } from "#core/host/panel.ts";
import { groupTitle, type PublishPlan } from "./overlays.ts";
import type { RunCommand } from "./use-commands.ts";

export interface PlanContext {
  state: ConsoleState;
  upstream: UpstreamContribution | undefined;
}

export function planForRow(row: ArtifactRow, context: PlanContext): PublishPlan | undefined {
  const { state, upstream } = context;
  // A folder a job carries goes back through that job, not a publish.
  if (row.carriedBy !== undefined) return undefined;
  const authored = row.state === "unpublished";
  if (row.state !== "edited" && !authored) return undefined;
  // An artifact from a namespace goes back to it on its own; only work authored here needs a registry.
  const alias = authored ? state.account?.registry : undefined;
  return {
    title: row.name,
    alias,
    namespace: row.namespace ?? state.account?.defaultNamespace,
    send: [row],
    skip: [],
    wholeGroupOnly: false,
    caution: upstream?.caution?.(row),
    command: commands.publish(
      [selector(row)],
      alias === undefined ? undefined : state.account?.defaultNamespace,
      state.scope,
    ).display,
  };
}

export function planForLine(line: Line | undefined, context: PlanContext): PublishPlan | undefined {
  if (line === undefined) return undefined;
  const { state, upstream } = context;
  const alias = state.account?.registry;
  if (line.kind === "artifact") return planForRow(line.row, context);
  const group = line.group;
  const ready = publishable(group);
  // Re-sending a pending artifact is refused and kills the rest of the batch.
  const skip = group.rows
    .filter((row) => row.state === "pending")
    .map((row) => ({ row, why: "already upstream, waiting for review" }));
  const target = group.authoredHere ? alias : undefined;
  return {
    title: groupTitle(group),
    alias: target,
    namespace: group.authoredHere ? state.account?.defaultNamespace : group.label,
    send: ready,
    skip,
    wholeGroupOnly: group.authoredHere,
    caution: ready.map((row) => upstream?.caution?.(row)).find((why) => why !== undefined),
    command: commands.publish(
      ready.map(selector),
      target === undefined ? undefined : state.account?.defaultNamespace,
      state.scope,
    ).display,
  };
}

export function importNow(row: ArtifactRow, run: RunCommand): boolean {
  if (row.carriedBy === undefined || row.state !== "edited") return false;
  run(`importing ${row.name}`, commands.runJob(row.carriedBy));
  return true;
}

export function runPlan(plan: PublishPlan, state: ConsoleState, run: RunCommand): void {
  if (plan.send.length === 0) return;
  run(
    `publishing ${plan.send.length}`,
    commands.publish(
      plan.send.map(selector),
      plan.alias === undefined ? undefined : plan.namespace,
      state.scope,
    ),
  );
}
