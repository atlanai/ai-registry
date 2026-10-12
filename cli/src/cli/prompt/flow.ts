import { relative } from "node:path";
import { list, plural } from "#adapter/text.ts";
import { foundBy } from "#cli/render/found.ts";
import type { Entry } from "#core/catalog/model.ts";
import {
  DEFAULT_TARGETS,
  detectAll,
  type Harnesses,
  readsFor,
  type Target,
  targetRoot,
} from "#core/harness/index.ts";
import { type ArtifactKind, KINDS, kindDir } from "#core/kinds.ts";
import type { Lock } from "#core/lock.ts";
import type { Printer } from "#core/output.ts";
import type { Plan } from "#core/plan/model.ts";
import { NAME } from "#core/product.ts";
import type { Scope } from "#core/store/paths.ts";
import { tableLines } from "#core/term/table.ts";
import { blocker, explain } from "./caller.ts";
import { type Choice, multiselect } from "./multiselect.ts";
import { type Canceled, canceled, type PromptIo, prepare } from "./prompt.ts";
import { note } from "./report.ts";
import { confirm, select } from "./select.ts";

/** Shared prompt state for commands that gather missing choices. */
export interface Interaction {
  io: PromptIo;
  printer: Printer;
  /** Undefined when prompting is allowed. */
  blocked: ReturnType<typeof blocker>;
}

export function interaction(printer: Printer, io: PromptIo, yes: boolean): Interaction {
  return {
    io,
    printer,
    blocked: blocker({
      json: printer.format === "json",
      yes,
      isTTY: io.input.isTTY === true,
    }),
  };
}

export function interactive(step: Interaction): boolean {
  return step.blocked === undefined;
}

/** Loads the prompts' renderer behind the slow work that comes before a step's first question. */
export function preparing(step: Interaction): void {
  if (interactive(step)) void prepare();
}

export function silence(step: Interaction): string | undefined {
  return step.blocked === undefined ? undefined : explain(step.blocked);
}

export function cancel(step: Interaction): void {
  step.io.output.write("\n");
  step.printer.info("Canceled. Nothing was changed.");
}

/** Picking a whole namespace answers with this, which no artifact name can be. */
function namespaceChoice(namespace: string): string {
  return `${namespace}/`;
}

/** The namespace a picked value stands for, when it stands for one. */
export function pickedNamespace(value: string): string | undefined {
  return value.endsWith("/") ? value.slice(0, -1) : undefined;
}

/**
 * Groups by plugin where the source publishes plugins, and by namespace where
 * it does not; a whole group is one selection, so it keeps what it adds later.
 */
export async function chooseArtifacts(
  step: Interaction,
  entries: readonly Entry[],
  preselected: readonly string[],
): Promise<string[] | Canceled> {
  const plugins = entries.filter((entry) => entry.kind === "plugin");
  const byNamespace = plugins.length === 0;
  const names = new Set(
    byNamespace
      ? entries.flatMap((entry) => (entry.group === undefined ? [] : [entry.group]))
      : plugins.map((entry) => entry.name),
  );

  const groupValues = new Map<string, string>();
  const groupDetails = new Map<string, string>();
  for (const entry of plugins) {
    groupValues.set(entry.name, entry.name);
    if (entry.description !== undefined) groupDetails.set(entry.name, entry.description);
  }
  for (const namespace of byNamespace ? names : []) {
    groupValues.set(namespace, namespaceChoice(namespace));
    groupDetails.set(namespace, `Everything ${namespace} publishes, including what it adds later.`);
  }

  const choices: Choice<string>[] = entries
    .filter((entry) => entry.kind !== "plugin")
    .map((entry) => ({
      // The full address, so two namespaces' artifacts of one name stay two choices.
      value: [entry.group, entry.kind, entry.name].filter(Boolean).join("/"),
      label: entry.name,
      hint: entry.kind,
      group: entry.group !== undefined && names.has(entry.group) ? entry.group : undefined,
      section: kindDir(entry.kind),
      detail: entry.description,
    }));

  const groupHints = new Map<string, string>();
  for (const name of names) {
    groupHints.set(name, contents(choices.filter((choice) => choice.group === name)));
  }

  const loose = choices.filter((choice) => choice.group === undefined).length;
  const rows = names.size + loose;

  return await multiselect(
    {
      message: "What should be installed?",
      choices: sortForDisplay(choices),
      style: step.printer.errStyle,
      initial: preselected,
      groupValues,
      groupDetails,
      groupHints,
      required: true,
      groups: true,
      collapsed: true,
      selectAll: rows <= SELECT_ALL_LIMIT,
      detail: true,
      maxVisible: 14,
    },
    step.io,
  );
}

/** What a group holds, by kind: "4 skills, 1 agent". */
function contents(members: readonly Choice<string>[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    const kind = member.hint ?? "artifact";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ordered = KINDS.filter((kind) => counts.has(kind));
  return ordered.map((kind) => plural(counts.get(kind) as number, kind)).join(", ");
}

/** Keep group and kind runs contiguous so headings cover the correct rows. */
function sortForDisplay(choices: readonly Choice<string>[]): Choice<string>[] {
  const rank = (choice: Choice<string>): number => {
    const index = KINDS.findIndex((kind) => kindDir(kind) === choice.section);
    return index === -1 ? KINDS.length : index;
  };
  return [...choices].sort((a, b) => {
    const groupA = a.group ?? "\uffff";
    const groupB = b.group ?? "\uffff";
    return groupA.localeCompare(groupB) || rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
}

/** Turn off the select-all key once a bulk choice is more likely accidental. */
const SELECT_ALL_LIMIT = 50;

export async function chooseTargets(
  step: Interaction,
  harnesses: Harnesses,
  scope: Scope,
  cwd: string,
  preselected: readonly string[],
): Promise<string[] | Canceled> {
  // A shared folder is where tools read from, not a tool to pick: choosing a
  // tool reaches it. One a manifest already names is kept as it was.
  const all = detectAll(harnesses, cwd).filter((item) => !item.target.shared);
  const kept = preselected.filter((name) => harnesses[name]?.shared === true);

  const where = (target: Target): string => {
    const root = targetRoot(target, scope, cwd);
    return scope === "user" ? root : relative(cwd, root) || root;
  };

  const choices: Choice<string>[] = all.map((item) => ({
    value: item.target.name,
    label: item.target.displayName,
    hint: where(item.target),
    detail: [
      item.detected ? `Found ${foundBy(item.by)}.` : "Not found on this machine.",
      `Takes ${kinds(item.target)}.`,
      ...borrowed(harnesses, item.target).map(
        ([kind, read]) => `Reads ${kind}s from ${where(read)}.`,
      ),
    ].join(" "),
  }));

  // The scope's own harnesses, or the defaults every scope starts with, so the
  // answer a person accepts is the one a command without --for would take.
  const selectable = new Set(all.map((item) => item.target.name));
  const remembered = preselected.filter((name) => selectable.has(name));
  const initial =
    remembered.length > 0 ? remembered : DEFAULT_TARGETS.filter((name) => selectable.has(name));

  const picked = await multiselect(
    {
      message: "Which harnesses should they install into?",
      choices,
      style: step.printer.errStyle,
      initial,
      detail: true,
    },
    step.io,
  );
  return canceled(picked) ? picked : [...picked, ...kept.filter((name) => !picked.includes(name))];
}

/** The kinds a tool reads first from another harness's folder, with that folder. */
function borrowed(harnesses: Harnesses, target: Target): [ArtifactKind, Target][] {
  return Object.entries(target.reads).flatMap(([kind, reads]) => {
    const read = reads?.[0] === undefined ? undefined : harnesses[reads[0]];
    return read === undefined || read.name === target.name ? [] : [[kind as ArtifactKind, read]];
  });
}

/** Group removal choices by their registry. */
export async function chooseRemovals(
  step: Interaction,
  installed: readonly { name: string; kind: string; source: string; targets: string[] }[],
): Promise<string[] | Canceled> {
  return await multiselect(
    {
      message: "Which artifacts should be removed?",
      choices: installed.map((entry) => ({
        value: entry.name,
        label: entry.name,
        hint: entry.kind,
        group: entry.source,
        detail:
          entry.targets.length > 0
            ? `Installed into ${entry.targets.join(", ")}.`
            : "Fetched, but installed into no harness.",
      })),
      style: step.printer.errStyle,
      required: true,
      groups: true,
      detail: true,
      selectAll: installed.length <= SELECT_ALL_LIMIT,
      maxVisible: 12,
    },
    step.io,
  );
}

/** What a harness takes, in a person's words: a plugin is how a namespace arrives, not a kind to pick. */
function kinds(target: Target): string {
  const taken = Object.keys(target.kinds)
    .filter((kind) => kind !== "plugin")
    .sort()
    .map((kind) => `${kind}s`);
  return taken.length === 0 ? "nothing" : list(taken);
}

export async function chooseScope(step: Interaction, initial: Scope): Promise<Scope | Canceled> {
  return await select<Scope>(
    {
      message: "Where should they be installed?",
      style: step.printer.errStyle,
      initial,
      options: [
        {
          value: "project",
          label: "Project",
          hint: "shared with the repo · ./.registry/",
        },
        {
          value: "user",
          label: "User",
          hint: "all your projects · ~/.registry/",
        },
      ],
    },
    step.io,
  );
}

/** Offer projection methods only when selected targets resolve to multiple roots. */
export function methodIsMeaningful(
  harnesses: Harnesses,
  targets: readonly string[],
  scope: Scope,
  cwd: string,
  kinds: readonly ArtifactKind[] = [],
): boolean {
  const chosen = targets
    .map((name) => harnesses[name])
    .filter((target): target is Target => target !== undefined)
    .filter(
      (target) => kinds.length === 0 || kinds.some((kind) => target.kinds[kind] !== undefined),
    );
  return new Set(chosen.map((target) => targetRoot(target, scope, cwd))).size > 1;
}

export async function chooseMethod(
  step: Interaction,
  initial: boolean,
): Promise<boolean | Canceled> {
  return await select<boolean>(
    {
      message: "How should harnesses reference the artifacts?",
      style: step.printer.errStyle,
      initial,
      options: [
        {
          value: false,
          label: "Symlink",
          hint: "one writable copy, edits reach every harness at once",
        },
        {
          value: true,
          label: "Copy",
          hint: "an independent copy per harness",
        },
      ],
    },
    step.io,
  );
}

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
  /** Harnesses this run was asked to write to. */
  targets?: readonly string[] | undefined;
  /** Kinds being installed, used to explain a harness that gets nothing. */
  kinds?: readonly ArtifactKind[] | undefined;
  harnesses?: Harnesses | undefined;
}

/** The plan, then one question. Nothing is written before the answer. */
export async function confirmPlan(
  step: Interaction,
  plan: Plan,
  context: PlanContext = {},
): Promise<boolean> {
  if (!interactive(step)) return true;
  note(step.io, step.printer.errStyle, "Plan", planLines(step, plan, context));
  // Deleting edits is the one answer that cannot be undone, so it is never the default.
  const loses = plan.actions.some((action) => action.kind === "unlink" && action.edited === true);
  const proceed = await confirm(
    { message: "Proceed?", style: step.printer.errStyle, initial: !loses },
    step.io,
  );
  return !canceled(proceed) && proceed;
}

/** Chosen harnesses the plan places nothing in, so the review can warn before it applies. */
export function unreached(plan: Plan, targets: readonly string[], harnesses?: Harnesses): string[] {
  const reached = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "link") reached.add(action.harness);
  }
  // A harness that reads another's folder is reached through it.
  const reads = (name: string) =>
    harnesses === undefined
      ? [name]
      : [name, ...KINDS.flatMap((kind) => readsFor(harnesses, name, kind))];
  return targets.filter((name) => !reads(name).some((read) => reached.has(read))).sort();
}

/** The kinds a harness cannot load, which explain why it was left out. */
export function unhandled(
  harnesses: Harnesses,
  target: string,
  kinds: readonly ArtifactKind[],
): ArtifactKind[] {
  const harness = harnesses[target];
  if (harness === undefined) return [];
  return kinds.filter((kind) => harness.kinds[kind] === undefined);
}

/**
 * A plugin is one plan entry but one link per member per harness, so a harness
 * is named once however many members point there.
 */
export function linkedTargets(plan: Plan): Map<string, string[]> {
  const linked = new Map<string, string[]>();
  for (const action of plan.actions) {
    if (action.kind !== "link") continue;
    const seen = linked.get(action.name);
    if (seen === undefined) linked.set(action.name, [action.harness]);
    else if (!seen.includes(action.harness)) seen.push(action.harness);
  }
  return linked;
}

function planLines(step: Interaction, plan: Plan, context: PlanContext): string[] {
  const style = step.printer.errStyle;
  const staged = new Set<string>();
  const removed = new Set<string>();
  const edited = new Set<string>();
  let recorded: Lock | undefined;

  for (const action of plan.actions) {
    if (action.kind === "stage") staged.add(action.name);
    else if (action.kind === "record") recorded = action.lock;
    else if (action.kind === "unlink") {
      removed.add(action.name);
      if (action.edited === true) edited.add(action.name);
    }
    // A clone is this scope's own copy, not a placement in someone's harness,
    // and a link is summarized by harness below, so neither gets its own line.
  }
  const linked = linkedTargets(plan);

  const names = [...new Set([...staged.keys(), ...linked.keys()])].sort();
  // A namespace installs as one plugin link, so the lock says where each member went.
  const folders = (name: string): string[] => [
    ...new Set([
      ...(linked.get(name) ?? []),
      ...(recorded?.artifacts[name]?.links.map((link) => link.harness) ?? []),
    ]),
  ];
  const chosen = context.targets ?? [];
  // The tools a person picked, not the folders written for them: one folder can
  // serve several tools, and a tool can read from another's folder.
  const loading = (name: string): string[] | undefined =>
    context.harnesses === undefined || chosen.length === 0
      ? undefined
      : chosen.filter((tool) =>
          loads(
            context.harnesses as Harnesses,
            tool,
            recorded?.artifacts[name]?.kind,
            folders(name),
          ),
        );

  // What a person decides on: which version, into which harnesses. Store paths are ours.
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
              header: "for",
              value: (name: string) => {
                const tools = loading(name);
                return tools === undefined
                  ? folders(name).sort().join(", ")
                  : tools.map((tool) => label(context.harnesses, tool)).join(", ");
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

  const missed = unreached(plan, context.targets ?? [], context.harnesses);
  const skips = skipped(names, chosen, missed, loading, folders);
  if ((missed.length > 0 || skips.size > 0) && names.length > 0) {
    lines.push("");
    if (missed.length > 0) {
      for (const line of explainMissed(missed, context)) lines.push(style.yellow(line));
    }
    for (const line of explainSkipped(skips, recorded, context)) {
      lines.push(style.yellow(line));
    }
  }
  return lines.length === 0 ? [style.dim("Nothing to do.")] : lines;
}

/** Whether a tool loads an artifact placed in these folders, its own or one it reads the kind from. */
function loads(
  harnesses: Harnesses,
  tool: string,
  kind: ArtifactKind | undefined,
  folders: readonly string[],
): boolean {
  if (folders.includes(tool)) return true;
  return (
    kind !== undefined && readsFor(harnesses, tool, kind).some((read) => folders.includes(read))
  );
}

/** A chosen harness by the name a person picked it by. */
function label(harnesses: Harnesses | undefined, name: string): string {
  const target = harnesses?.[name];
  if (target === undefined) return name;
  return target.shared ? target.projectRoot : target.displayName;
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

/** One line per tool: what it skips, and the kind it cannot load when that is why. */
function explainSkipped(
  skips: ReadonlyMap<string, string[]>,
  recorded: Lock | undefined,
  context: PlanContext,
): string[] {
  const { harnesses } = context;
  if (harnesses === undefined) return [];
  return [...skips.entries()].map(([tool, names]) => {
    const kinds = [
      ...new Set(
        names.flatMap((name) => {
          const kind = recorded?.artifacts[name]?.kind;
          return kind === undefined ? [] : [kind];
        }),
      ),
    ];
    const reason = unhandled(harnesses, tool, kinds);
    const because =
      reason.length === 0 ? "" : `: it does not load ${list(reason.map((kind) => `${kind}s`))}`;
    return `${label(harnesses, tool)} skips ${list(names)}${because}.`;
  });
}

/** Group unreached harnesses by unsupported kinds for concise reporting. */
function explainMissed(missed: readonly string[], context: PlanContext): string[] {
  const { harnesses, kinds } = context;
  const named = (targets: readonly string[]) => list(targets.map((t) => label(harnesses, t)));
  const receive = (targets: readonly string[]) => (targets.length === 1 ? "receives" : "receive");
  const vague = (targets: readonly string[]): string =>
    `${named(targets)} ${receive(targets)} nothing from this selection.`;
  if (harnesses === undefined || kinds === undefined || kinds.length === 0) {
    return [vague(missed)];
  }

  const byReason = new Map<string, string[]>();
  for (const target of missed) {
    const reason = unhandled(harnesses, target, kinds).sort().join(",");
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

/** Render the equivalent non-interactive command. */
export function equivalent(
  command: string,
  source: string | undefined,
  options: {
    select?: readonly string[] | undefined;
    targets?: readonly string[] | undefined;
    scope?: Scope | undefined;
    copy?: boolean | undefined;
  },
): string {
  const parts: string[] = [NAME, command];
  if (source !== undefined) parts.push(source);
  for (const name of options.select ?? []) parts.push("-s", name);
  if (options.targets !== undefined && options.targets.length > 0) {
    parts.push("--for", [...options.targets].sort().join(","));
  }
  if (options.scope === "user") parts.push("-g");
  if (options.copy === true) parts.push("--copy");
  parts.push("-y");
  return parts.join(" ");
}
