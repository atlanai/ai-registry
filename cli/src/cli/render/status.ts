import type { ArtifactKind } from "#adapter/kinds.ts";
import { list, plural } from "#adapter/text.ts";
import { STATE_MEANING, stateTone } from "#core/console/state-style.ts";
import type { ArtifactStatus, LinkState, State } from "#core/plan/status.ts";
import { type Scope, scopeFlag, scopeName } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { GLYPH } from "#core/term/theme.ts";
import { heading, type Installed, identity } from "./installed.ts";
import { loadedBy, skipLine, stateFor, toolName } from "./tools.ts";

/** A state as a person reads it; `--json` keeps the name the state has in the lockfile check. */
const SHOWN_STATE: Partial<Record<State, string>> = { dangling: "replaced" };

export function renderStatus(
  printer: Printer,
  statuses: readonly ArtifactStatus[],
  rows: readonly Installed[],
  scope: Scope,
  chosen: Chosen,
): void {
  if (statuses.length === 0) {
    printer.info(`Nothing is installed in ${scopeName(scope)}.`);
    return;
  }

  const byName = new Map(rows.map((row) => [row.name, row]));
  // A watched artifact is its target's own folder, which aireg reads and never links.
  const watching = (item: ArtifactStatus): string | undefined =>
    byName.get(item.name)?.watched?.target;
  const kindOf = (item: ArtifactStatus) => byName.get(item.name)?.kind as ArtifactKind | undefined;
  const toolsOf = (item: ArtifactStatus, folders: readonly string[]): string[] =>
    loadedBy(chosen.targetTable, chosen.for(item.name), kindOf(item), folders);
  const watchedBy = (item: ArtifactStatus): string[] => {
    const watched = watching(item);
    return watched === undefined ? [] : toolsOf(item, [watched]);
  };
  // One column per target, in the order aireg lists them.
  const order = Object.keys(chosen.targetTable);
  const tools = [
    ...new Set(
      statuses.flatMap((item) => [...toolsOf(item, Object.keys(item.targets)), ...watchedBy(item)]),
    ),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const of = (item: ArtifactStatus): Installed =>
    byName.get(item.name) ?? {
      name: item.name,
      shown: item.name,
      kind: "",
      registry: "",
      address: "",
      ref: "",
      pinned: false,
      targets: [],
    };

  // A detail names the folder its link is in; the column already names the target.
  const detailFor = (item: ArtifactStatus, detail: string): string => {
    const at = detail.indexOf(": ");
    const folder = at === -1 ? "" : detail.slice(0, at);
    if (chosen.targetTable[folder] === undefined) return detail;
    const tools = toolsOf(item, [folder]);
    return tools.length === 1
      ? detail.slice(at + 2)
      : `${list(tools.map((tool) => toolName(chosen.targetTable, tool)))}: ${detail.slice(at + 2)}`;
  };

  heading(printer, statuses.length, scope);
  table(
    printer,
    [
      ...identity(printer, of),
      ...tools.map((tool) => ({
        header: toolName(chosen.targetTable, tool),
        value: (item: ArtifactStatus) => {
          const seen = toolsOf(item, Object.keys(item.targets)).includes(tool)
            ? stateFor(chosen.targetTable, tool, kindOf(item), item.targets)
            : undefined;
          return seen === undefined && watchedBy(item).includes(tool)
            ? printer.style.dim("watched")
            : cell(printer, seen);
        },
      })),
      {
        header: "state",
        value: (item: ArtifactStatus) =>
          printer.style[stateTone(item.state)](SHOWN_STATE[item.state] ?? item.state),
      },
      {
        header: "detail",
        value: (item: ArtifactStatus) =>
          item.state === "ok" || item.detail === undefined
            ? ""
            : printer.style.dim(detailFor(item, item.detail)),
        optional: true,
      },
    ],
    statuses,
  );

  const attention = statuses.filter((item) => item.state !== "ok").length;
  printer.info();
  // Each `-` said in words, as the install plan says it.
  const skipped = new Map<string, Installed[]>();
  for (const item of statuses) {
    for (const tool of tools) {
      if (
        !toolsOf(item, Object.keys(item.targets)).includes(tool) &&
        !watchedBy(item).includes(tool)
      )
        skipped.set(tool, [...(skipped.get(tool) ?? []), of(item)]);
    }
  }
  for (const [tool, missed] of skipped) {
    const kinds = [...new Set(missed.map((row) => row.kind as ArtifactKind))];
    printer.info(
      printer.style.dim(
        skipLine(
          chosen.targetTable,
          tool,
          missed.map((row) => row.shown),
          kinds,
        ),
      ),
    );
  }
  if (attention === 0) {
    printer.success("Everything matches the lockfile.");
    return;
  }
  if (attention < statuses.length) printer.info(printer.style.dim(`ok  ${STATE_MEANING.ok}`));
  printer.info(`${plural(attention, "artifact")} need${attention === 1 ? "s" : ""} attention.`);

  repairHint(printer, statuses, scope, chosen, kindOf);
}

/** Which targets each artifact was chosen for, so columns name targets rather than folders. */
export interface Chosen {
  targetTable: Targets;
  for: (name: string) => readonly string[];
}

function cell(printer: Printer, seen: LinkState | undefined): string {
  const { style } = printer;
  if (seen === undefined) return style.dim("-");
  if (seen === "linked") return style.green(GLYPH.ok);
  return seen === "missing" ? style.red(seen) : style.yellow(seen);
}

/** What to run next: `install --force` for a copy aireg wrote, `sync` for an edit, else `install`. */
function repairHint(
  printer: Printer,
  statuses: readonly ArtifactStatus[],
  scope: Scope,
  chosen: Chosen,
  kindOf: (item: ArtifactStatus) => ArtifactKind | undefined,
): void {
  const flag = scopeFlag(scope);
  // A copy aireg writes into a target's folder holds no edit sync could send back.
  const writtenFor = (item: ArtifactStatus): { tool: string; kind: string } | undefined => {
    const folder = item.detail?.split(": ")[0] ?? "";
    const kind = kindOf(item);
    const mapping = kind === undefined ? undefined : chosen.targetTable[folder]?.kinds[kind];
    if (kind === undefined || mapping === undefined) return undefined;
    return mapping.codec !== undefined || mapping.place === "copy"
      ? { tool: folder, kind }
      : undefined;
  };
  const edits = statuses.filter((item) => item.state === "edited");
  const written = edits.flatMap((item) => writtenFor(item) ?? []);
  const edited = edits.length > written.length;
  const absent = statuses.some((item) => item.state === "missing" || item.state === "dangling");
  if (!edited && written.length > 0) {
    const tools = [...new Set(written.map((each) => each.tool))].map((tool) =>
      toolName(chosen.targetTable, tool),
    );
    const kinds = new Set(written.map((each) => each.kind));
    const kind = kinds.size === 1 ? [...kinds][0] : "artifact";
    printer.hint(
      `${list(tools)} read${tools.length === 1 ? "s" : ""} a copy aireg writes from the ${kind}: run \`aireg install${flag} --force\` to write it again, and change the ${kind} in its registry.`,
    );
  } else if (edited) {
    // `install` refuses to overwrite an edit, so point at `sync`, which reconciles one.
    printer.hint(
      `Run \`aireg sync${flag}\` to compare the edits with the registry` +
        (absent ? `, and \`aireg install${flag}\` to restore what is missing.` : "."),
    );
  } else if (absent) {
    printer.hint(absentHint(statuses, flag));
  }
}

/** What puts a missing link back: `install`, once a folder of yours or the setting allows it. */
function absentHint(statuses: readonly ArtifactStatus[], flag: string): string {
  const repairable = statuses.some(
    (item) => (item.state === "missing" || item.state === "dangling") && item.blocked !== true,
  );
  if (repairable) return `Run \`aireg install${flag}\` to restore what is missing.`;
  if (statuses.some((item) => item.taken === true)) {
    return `Run \`aireg install${flag}\` with \`defaults.name-collision\` set to rename, the default, to install what was left out under its namespace and name.`;
  }
  return `Move what is in the way, then run \`aireg install${flag}\`.`;
}
