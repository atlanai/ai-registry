import { type ArtifactKind, KINDS } from "#adapter/kinds.ts";
import { list, plural } from "#adapter/text.ts";
import { loadedBy, skipLine, toolName, unhandled } from "#cli/render/tools.ts";
import type { Lock } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import type { Targets } from "#core/target/contract.ts";
import { readsFor } from "#core/target/placement.ts";
import { tableLines } from "#core/term/table.ts";
import { type Interaction, interactive } from "./interaction.ts";
import { canceled } from "./model.ts";
import { confirm } from "./select.ts";

export function destroys(plan: Plan): boolean {
  return plan.actions.some((action) => action.kind === "unlink");
}

/** Require confirmation only when this plan removes installed state. */
export async function confirmIfDestructive(
  step: Interaction,
  plan: Plan,
  context: PlanContext = {},
): Promise<boolean> {
  if (!destroys(plan)) return true;
  return await confirmPlan(step, plan, context);
}

export interface PlanContext {
  /** What confirming does, which titles the question. */
  verb?: "Install" | "Remove" | "Update" | undefined;
  /** Targets this run was asked to write to. */
  targets?: readonly string[] | undefined;
  /** Kinds being installed, used to explain a target that gets nothing. */
  kinds?: readonly ArtifactKind[] | undefined;
  targetTable?: Targets | undefined;
}

/** Asked for each plugin that runs things as you; no is the default, and the answer without a terminal. */
export async function confirmTrust(
  step: Interaction,
  name: string,
  carries: string,
): Promise<boolean> {
  if (!interactive(step)) return false;
  const answer = await confirm(
    {
      message: `${name} carries ${carries}, which a target that loads it runs as you. Install it?`,
      style: step.printer.errStyle,
      initial: false,
    },
    step.io,
  );
  return !canceled(answer) && answer;
}

/** The plan, then one question. Nothing is written before the answer. */
export async function confirmPlan(
  step: Interaction,
  plan: Plan,
  context: PlanContext = {},
): Promise<boolean> {
  if (!interactive(step)) return true;
  // Nothing on disk would change, so there is nothing to agree to.
  if (plan.actions.every((action) => action.kind === "record")) return true;
  // Deleting edits is the one answer that cannot be undone, so it is never the default.
  const loses = plan.actions.some((action) => action.kind === "unlink" && action.edited === true);
  const proceed = await confirm(
    {
      message: planQuestion(plan, context.verb ?? "Install"),
      style: step.printer.errStyle,
      initial: !loses,
      body: planLines(step, plan, context),
    },
    step.io,
  );
  return !canceled(proceed) && proceed;
}

function planQuestion(plan: Plan, verb: "Install" | "Remove" | "Update"): string {
  const placed = new Set<string>();
  const removed = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "stage" || action.kind === "link") placed.add(action.name);
    else if (action.kind === "unlink") removed.add(action.name);
  }
  // A plan that only removes says so, whatever the command; an update counts both.
  const [said, count] =
    verb === "Update"
      ? [verb, new Set([...placed, ...removed]).size]
      : verb === "Remove" || placed.size === 0
        ? (["Remove", removed.size] as const)
        : ([verb, placed.size] as const);
  return `${said} ${plural(count, "artifact")}?`;
}

function planLines(step: Interaction, plan: Plan, context: PlanContext): string[] {
  const style = step.printer.errStyle;
  const staged = new Set<string>();
  const removed = new Set<string>();
  const edited = new Set<string>();
  let recorded: Lock | undefined;

  // A clone is this scope's own copy, not a placement in a target's folder, and a link
  // is summarized by target below, so neither gets its own line.
  for (const action of plan.actions) {
    if (action.kind === "stage") staged.add(action.name);
    else if (action.kind === "record") recorded = action.lock;
    else if (action.kind === "unlink") {
      removed.add(action.name);
      if (action.edited === true) edited.add(action.name);
    }
  }
  const linked = linkedTargets(plan);

  const names = [...new Set([...staged.keys(), ...linked.keys()])].sort();
  // A namespace installs as one plugin link, so the lock says where each member went.
  const folders = (name: string): string[] => [
    ...new Set([
      ...(linked.get(name) ?? []),
      ...(recorded?.artifacts[name]?.links.map((link) => link.target) ?? []),
    ]),
  ];
  const chosen = context.targets ?? [];
  // The tools a person picked, not the folders written for them: one folder can
  // serve several tools, and a tool can read from another's folder.
  const loading = (name: string): string[] | undefined =>
    context.targetTable === undefined || chosen.length === 0
      ? undefined
      : loadedBy(context.targetTable, chosen, recorded?.artifacts[name]?.kind, folders(name));

  // What a person decides on: which version, into which targets. Store paths are ours.
  const lines =
    names.length === 0
      ? []
      : tableLines(
          style,
          [
            { header: "artifact", value: (name: string) => style.cyan(name) },
            {
              header: "version",
              value: (name: string) =>
                style.dim(
                  recorded?.artifacts[name]?.version ?? (staged.has(name) ? "new" : "relinked"),
                ),
            },
            {
              header: "targets",
              value: (name: string) => {
                const tools = loading(name);
                return tools === undefined
                  ? folders(name).sort().join(", ")
                  : tools.map((tool) => toolName(context.targetTable, tool)).join(", ");
              },
              optional: true,
            },
            {
              header: "",
              value: (name: string) => {
                const by = plan.neededBy[name];
                return by === undefined ? "" : style.dim(`needed by ${by.join(", ")}`);
              },
              optional: true,
            },
          ],
          names,
          { indent: 0 },
        );
  for (const name of [...removed].sort()) {
    const marked = edited.has(name)
      ? `  ${style.red("has local edits")}`
      : plan.pruned.includes(name)
        ? `  ${style.dim("no longer needed")}`
        : "";
    lines.push(`${style.yellow("remove")} ${name}${marked}`);
  }
  if (plan.unchanged.length > 0) {
    lines.push(style.dim(`${plan.unchanged.length} already up to date`));
  }

  if (names.length > 0) {
    const missed = unreached(plan, chosen, context.targetTable);
    const notes = [
      ...explainMissed(missed, context),
      ...explainSkipped(skipped(names, chosen, missed, loading, folders), recorded, context),
    ];
    if (notes.length > 0) lines.push("", ...notes.map((line) => style.yellow(line)));
  }
  return lines.length === 0 ? [style.dim("Nothing to do.")] : lines;
}

/** Group unreached targets by unsupported kinds for concise reporting. */
function explainMissed(missed: readonly string[], context: PlanContext): string[] {
  if (missed.length === 0) return [];
  const { targetTable, kinds } = context;
  const named = (targets: readonly string[]) => list(targets.map((t) => toolName(targetTable, t)));
  const receive = (targets: readonly string[]) => (targets.length === 1 ? "receives" : "receive");
  const vague = (targets: readonly string[]): string =>
    `${named(targets)} ${receive(targets)} nothing from this selection.`;
  if (targetTable === undefined || kinds === undefined || kinds.length === 0) {
    return [vague(missed)];
  }

  const byReason = new Map<string, string[]>();
  for (const target of missed) {
    const reason = unhandled(targetTable, target, kinds).sort().join(",");
    byReason.set(reason, [...(byReason.get(reason) ?? []), target]);
  }

  return [...byReason.entries()].map(([reason, targets]) =>
    reason === ""
      ? vague(targets)
      : `${named(targets)} ${receive(targets)} nothing: ${targets.length === 1 ? "it does not" : "they do not"} load ${list(
          reason.split(",").map((kind) => `${kind}s`),
        )}.`,
  );
}

/** One line per tool: what it skips, and the kind it cannot load when that is why. */
function explainSkipped(
  skips: ReadonlyMap<string, string[]>,
  recorded: Lock | undefined,
  context: PlanContext,
): string[] {
  const { targetTable } = context;
  if (targetTable === undefined) return [];
  return [...skips.entries()].map(([tool, names]) => {
    const kinds = [
      ...new Set(
        names.flatMap((name) => {
          const kind = recorded?.artifacts[name]?.kind;
          return kind === undefined ? [] : [kind];
        }),
      ),
    ];
    return skipLine(targetTable, tool, names, kinds);
  });
}

/** The artifacts each chosen tool is left without, for tools that receive something else. */
function skipped(
  names: readonly string[],
  chosen: readonly string[],
  missed: readonly string[],
  loading: (name: string) => string[] | undefined,
  folders: (name: string) => string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of names) {
    if (folders(name).length === 0) continue;
    const tools = loading(name);
    if (tools === undefined) continue;
    for (const tool of chosen) {
      if (missed.includes(tool) || tools.includes(tool)) continue;
      out.set(tool, [...(out.get(tool) ?? []), name]);
    }
  }
  return out;
}

/** Chosen targets the plan places nothing in, so the review can warn before it applies. */
export function unreached(plan: Plan, targets: readonly string[], targetTable?: Targets): string[] {
  const reached = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "link") reached.add(action.target);
  }
  // A target that reads another's folder is reached through it.
  const reads = (name: string) =>
    targetTable === undefined
      ? [name]
      : [name, ...KINDS.flatMap((kind) => readsFor(targetTable, name, kind))];
  return targets.filter((name) => !reads(name).some((read) => reached.has(read))).sort();
}

/**
 * A plugin is one plan entry but one link per member per target, so a target
 * is named once however many members point there.
 */
export function linkedTargets(plan: Plan): Map<string, string[]> {
  const linked = new Map<string, string[]>();
  for (const action of plan.actions) {
    if (action.kind !== "link") continue;
    const seen = linked.get(action.name);
    if (seen === undefined) linked.set(action.name, [action.target]);
    else if (!seen.includes(action.target)) seen.push(action.target);
  }
  return linked;
}
