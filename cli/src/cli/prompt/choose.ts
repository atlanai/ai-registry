import { relative } from "node:path";
import { type ArtifactKind, KINDS } from "#adapter/kinds.ts";
import { list, plural } from "#adapter/text.ts";
import { underHome } from "#cli/render/home.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { kindDir } from "#core/kinds.ts";
import type { Selected } from "#core/plan/model.ts";
import { loadsFrom, type ProjectionOptions } from "#core/plan/projection.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Target, Targets } from "#core/target/contract.ts";
import { detectAll } from "#core/target/detect.ts";
import { DEFAULT_TARGETS } from "#core/target/ids.ts";
import { targetRoot } from "#core/target/roots.ts";
import { namespaceChoice } from "#engine/address/qualify.ts";
import type { Interaction } from "./interaction.ts";
import { type Canceled, canceled } from "./model.ts";
import { type Choice, multiselect } from "./multiselect.ts";
import { select } from "./select.ts";

/** By plugin, else namespace; a whole group is one selection, so it keeps what is added later. */
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

  // Values are full addresses, so two namespaces' artifacts of one name stay two choices.
  const choices: Choice<string>[] = entries
    .filter((entry) => entry.kind !== "plugin")
    .map((entry) => ({
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
  targetTable: Targets,
  roots: ProjectionOptions["roots"],
  preselected: readonly string[],
  items: readonly Selected[],
  /** Its source installs each namespace as a plugin in the user scope. */
  wrapped = false,
): Promise<string[] | Canceled> {
  // A shared folder is where tools read from, not a tool to pick: choosing a
  // tool reaches it. One a manifest already names is kept as it was.
  const all = detectAll(targetTable, { cwd: roots.cwd, env: process.env }).filter(
    (item) => !item.target.shared,
  );
  const kept = preselected.filter((name) => targetTable[name]?.shared === true);
  const show = (path: string): string =>
    roots.scope === "user" ? underHome(path) : relative(roots.cwd, path) || path;
  const folders = (name: string, chosen: readonly string[]): string[] =>
    loadsFrom(name, chosen, items, { roots, targetTable, env: process.env }, wrapped);

  const choices: Choice<string>[] = all.map((item) => ({
    value: item.target.name,
    label: item.target.displayName,
  }));

  // The scope's targets or the defaults, so the accepted answer matches a command without --for.
  const selectable = new Set(all.map((item) => item.target.name));
  const remembered = preselected.filter((name) => selectable.has(name));
  const wanted =
    remembered.length > 0 ? remembered : DEFAULT_TARGETS.filter((name) => selectable.has(name));
  // A target that would load none of it is left for a person to pick on purpose.
  const initial = wanted.filter((name) => folders(name, wanted).length > 0);

  const picked = await multiselect(
    {
      message: "Which targets should they install into?",
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
            ? `Installed for ${list(entry.targets)}.`
            : "Fetched, but installed into no target.",
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
  targetTable: Targets,
  targets: readonly string[],
  scope: Scope,
  cwd: string,
  kinds: readonly ArtifactKind[] = [],
): boolean {
  const chosen = targets
    .map((name) => targetTable[name])
    .filter((target): target is Target => target !== undefined)
    .filter(
      (target) => kinds.length === 0 || kinds.some((kind) => target.kinds[kind] !== undefined),
    );
  return (
    new Set(chosen.map((target) => targetRoot(target, { scope, cwd, env: process.env }))).size > 1
  );
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
