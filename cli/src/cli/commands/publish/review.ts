import type { PublishRelationship } from "#adapter/index.ts";
import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm } from "#cli/prompt/select.ts";
import { underHome } from "#cli/render/home.ts";
import { changeLines } from "#engine/publish/changes.ts";
import type { Skipped } from "#engine/publish/exports.ts";
import type { Planned, Published } from "#engine/publish/target.ts";

export function describeSkip(skip: Skipped, namespace: string): string {
  return `  skip    ${namespace}/${skip.kind}/${skip.name}  ${skip.reason}`;
}

/** The plan, then one question; what is already published is shown and never sent. */
export async function review(
  context: CommandContext,
  step: Interaction,
  planned: Sending,
  open: (alias: string) => Promise<Published>,
  dryRun: boolean,
  asks: (alias: string) => Promise<boolean>,
  skipped: { into: string; namespace: string; skipped: readonly Skipped[] } | undefined,
): Promise<Sending | undefined> {
  const printer = context.printer;
  const lines: string[] = [];
  for (const alias of new Set(planned.map((entry) => entry.alias))) {
    const { location } = await open(alias);
    lines.push(
      location === alias ? underHome(alias) : `${alias}  ${printer.style.dim(underHome(location))}`,
    );
    for (const { item } of planned.filter((entry) => entry.alias === alias))
      lines.push(...describe(item));
    if (alias === skipped?.into)
      for (const skip of skipped.skipped) lines.push(describeSkip(skip, skipped.namespace));
  }
  const print = () => {
    for (const line of lines) printer.info(line);
  };
  const sending = planned.filter(({ item }) => !item.same);
  if (sending.length === 0) {
    print();
    printer.info(printer.style.dim("Nothing new to publish."));
    return undefined;
  }
  if (dryRun || !interactive(step)) {
    print();
    return dryRun ? undefined : sending;
  }
  // A source that asks why the change was made asks that instead; canceling it still sends nothing.
  const asking = await Promise.all([...new Set(sending.map((entry) => entry.alias))].map(asks));
  if (asking.every(Boolean)) {
    print();
    return sending;
  }
  // The plan is the question's body, so it reads as one step, as `add` and `remove` do.
  const proceed = await confirm(
    {
      message: `Publish ${plural(sending.length, "artifact")}?`,
      style: printer.errStyle,

      body: lines.map((line) => line.replace(/^ {2}/, "")),
    },
    step.io,
  );
  if (!canceled(proceed) && proceed) return sending;
  printer.info("Canceled. Nothing was published.");
  return undefined;
}

function describe(item: Planned): string[] {
  const address = `${item.namespace}/${item.work.kind}/${item.work.name}`;
  const edges = item.input.relationships ?? [];
  const needs = edges.length === 0 ? "" : `, depends on ${edges.map(dependencyOf).join(", ")}`;
  if (item.same) return [`  same    ${address}  ${item.version}, already published${needs}`];
  if (item.from === undefined) return [`  add     ${address}  ${item.version}${needs}`];
  const below = item.belowLatest ? " (below latest)" : "";
  return [
    `  update  ${address}  ${item.from} → ${item.version}${below}${needs}`,
    ...(item.changes === undefined ? [] : changeLines(item.changes)),
  ];
}

export type Sending = { alias: string; item: Planned }[];

function dependencyOf(edge: PublishRelationship): string {
  const at = edge.to.lastIndexOf("@");
  const name = edge.to.slice(0, at).split("/").at(-1);
  return `${name} ${edge.to.slice(at + 1)}`;
}
