import { relative } from "node:path";
import { list, plural } from "#adapter/text.ts";
import { underHome } from "#cli/render/home.ts";
import { loadedBy, toolName } from "#cli/render/tools.ts";
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
import type { Plan, Selected } from "#core/plan/model.ts";
import { loadsFrom, type ProjectionOptions } from "#core/plan/projection.ts";
import { NAME } from "#core/product.ts";
import type { Scope } from "#core/store/paths.ts";
import { tableLines } from "#core/term/table.ts";
import { blocker, explain } from "./caller.ts";
import { type Choice, multiselect } from "./multiselect.ts";
import { type Canceled, canceled, type PromptIo, prepare } from "./prompt.ts";
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
  roots: ProjectionOptions["roots"],
  preselected: readonly string[],
  /** What is being installed, so each harness can show where it would load it from. */
  items: readonly Selected[],
): Promise<string[] | Canceled> {
  // A shared folder is where tools read from, not a tool to pick: choosing a
  // tool reaches it. One a manifest already names is kept as it was.
  const all = detectAll(harnesses, roots.cwd).filter((item) => !item.target.shared);
  const kept = preselected.filter((name) => harnesses[name]?.shared === true);
  const show = (path: string): string =>
    roots.scope === "user" ? underHome(path) : relative(roots.cwd, path) || path;
  const folders = (name: string, chosen: readonly string[]): string[] =>
    loadsFrom(name, chosen, items, { roots, harnesses });

  const choices: Choice<string>[] = all.map((item) => ({
    value: item.target.name,
    label: item.target.displayName,
  }));

  // The scope's own harnesses, or the defaults every scope starts with, so the
  // answer a person accepts is the one a command without --for would take.
  const selectable = new Set(all.map((item) => item.target.name));
  const remembered = preselected.filter((name) => selectable.has(name));
  const wanted =
    remembered.length > 0 ? remembered : DEFAULT_TARGETS.filter((name) => selectable.has(name));
  // A harness that would load none of it is left for a person to pick on purpose.
  const initial = wanted.filter((name) => folders(name, wanted).length > 0);

  const picked = await multiselect(
    {
      message: "Which harnesses should they install into?",
      choices,
      style: step.printer.errStyle,
      initial,
      focusHint: (name, chosen) => {
        const found = folders(name, [...chosen]);
        return found.length === 0 ? "-" : found.map(show).join(", ");
      },
    },
    step.io,
  );
  return canceled(picked) ? picked : [...picked, ...kept.filter((name) => !picked.includes(name))];
}

/** Group removal choices by their registry. */
export async function chooseRemovals(
  step: Interaction,
  /** `targets` are the harnesses that load each one, by name. */
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
            ? `Installed for ${list(entry.targets)}.`
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
      message: "How should they be installed?",
      style: step.printer.errStyle,
      initial,
      options: [
        { value: false, label: "Symlink (recommended)", answer: "Symlink" },
        { value: true, label: "Copy" },
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
  /** What confirming does, which titles the question: `Install 2 artifacts?`. */
  verb?: "Install" | "Remove" | "Update" | undefined;
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

/** The question a plan asks, named by what it does and to how many: `Remove 1 artifact?`. */
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
      : loadedBy(context.harnesses, chosen, recorded?.artifacts[name]?.kind, folders(name));

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
              header: "harnesses",
              value: (name: string) => {
                const tools = loading(name);
                return tools === undefined
                  ? folders(name).sort().join(", ")
                  : tools.map((tool) => toolName(context.harnesses, tool)).join(", ");
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
    const missed = unreached(plan, chosen, context.harnesses);
    const notes = [
      ...explainMissed(missed, context),
      ...explainSkipped(skipped(names, chosen, missed, loading, folders), recorded, context),
    ];
    if (notes.length > 0) lines.push("", ...notes.map((line) => style.yellow(line)));
  }
  return lines.length === 0 ? [style.dim("Nothing to do.")] : lines;
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
    return `${toolName(harnesses, tool)} skips ${list(names)}${because}.`;
  });
}

/** Group unreached harnesses by unsupported kinds for concise reporting. */
function explainMissed(missed: readonly string[], context: PlanContext): string[] {
  if (missed.length === 0) return [];
  const { harnesses, kinds } = context;
  const named = (targets: readonly string[]) => list(targets.map((t) => toolName(harnesses, t)));
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
