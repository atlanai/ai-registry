import { list, plural } from "#adapter/text.ts";
import { STATE_MEANING, stateTone } from "#core/console/state-style.ts";
import type { Harnesses } from "#core/harness/index.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import type { Printer } from "#core/output.ts";
import type { ArtifactStatus, LinkState, State } from "#core/plan/status.ts";
import { type Scope, scopeName } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { heading, type Installed, identity } from "./installed.ts";
import { loadedBy, skipLine, stateFor, toolName } from "./tools.ts";

/** A state as a person reads it; `--json` keeps the name the state has in the lockfile check. */
const SHOWN_STATE: Partial<Record<State, string>> = { dangling: "replaced" };

function cell(printer: Printer, seen: LinkState | undefined): string {
  const { style } = printer;
  if (seen === undefined) return style.dim("-");
  if (seen === "linked") return style.green("✓");
  return seen === "missing" ? style.red(seen) : style.yellow(seen);
}

/** Which harnesses each artifact was chosen for, so columns name harnesses rather than folders. */
export interface Chosen {
  harnesses: Harnesses;
  for: (name: string) => readonly string[];
}

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
  // A watched artifact is its harness's own folder, which aireg reads and never links.
  const watching = (item: ArtifactStatus): string | undefined =>
    byName.get(item.name)?.watched?.harness;
  const kindOf = (item: ArtifactStatus) => byName.get(item.name)?.kind as ArtifactKind | undefined;
  const toolsOf = (item: ArtifactStatus, folders: readonly string[]): string[] =>
    loadedBy(chosen.harnesses, chosen.for(item.name), kindOf(item), folders);
  const watchedBy = (item: ArtifactStatus): string[] => {
    const watched = watching(item);
    return watched === undefined ? [] : toolsOf(item, [watched]);
  };
  // One column per harness, in the order aireg lists them.
  const order = Object.keys(chosen.harnesses);
  const tools = [
    ...new Set(
      statuses.flatMap((item) => [
        ...toolsOf(item, Object.keys(item.harnesses)),
        ...watchedBy(item),
      ]),
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

  // A detail names the folder its link is in; the column already names the harness.
  const detailFor = (item: ArtifactStatus, detail: string): string => {
    const at = detail.indexOf(": ");
    const folder = at === -1 ? "" : detail.slice(0, at);
    if (chosen.harnesses[folder] === undefined) return detail;
    const tools = toolsOf(item, [folder]);
    return tools.length === 1
      ? detail.slice(at + 2)
      : `${list(tools.map((tool) => toolName(chosen.harnesses, tool)))}: ${detail.slice(at + 2)}`;
  };

  heading(printer, statuses.length, scope);
  table(
    printer,
    [
      ...identity(printer, of),
      ...tools.map((tool) => ({
        header: toolName(chosen.harnesses, tool),
        value: (item: ArtifactStatus) => {
          const seen = toolsOf(item, Object.keys(item.harnesses)).includes(tool)
            ? stateFor(chosen.harnesses, tool, kindOf(item), item.harnesses)
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
        !toolsOf(item, Object.keys(item.harnesses)).includes(tool) &&
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
          chosen.harnesses,
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

  // An edit is the one state `install` will not repair: it refuses to overwrite
  // an edit, so point at `sync`, which reconciles one.
  const flag = scope === "user" ? " -g" : "";
  // A file written in a harness's own format holds no edit sync could send back.
  const writtenFor = (item: ArtifactStatus): string | undefined => {
    const folder = item.detail?.split(": ")[0] ?? "";
    const kind = kindOf(item);
    const mapping = kind === undefined ? undefined : chosen.harnesses[folder]?.kinds[kind];
    return mapping?.render === undefined ? undefined : folder;
  };
  const edits = statuses.filter((item) => item.state === "edited");
  const written = edits.flatMap((item) => writtenFor(item) ?? []);
  const edited = edits.length > written.length;
  const absent = statuses.some((item) => item.state === "missing" || item.state === "dangling");
  if (!edited && written.length > 0) {
    const tools = [...new Set(written)].map((tool) => toolName(chosen.harnesses, tool));
    printer.hint(
      `${list(tools)} read${tools.length === 1 ? "s" : ""} a copy aireg writes from the agent: run \`aireg install${flag} --force\` to write it again, and change the agent in its registry.`,
    );
  } else if (edited) {
    printer.hint(
      `Run \`aireg sync${flag}\` to compare the edits with the registry` +
        (absent ? `, and \`aireg install${flag}\` to restore what is missing.` : "."),
    );
  } else if (absent) {
    const repairable = statuses.some(
      (item) => (item.state === "missing" || item.state === "dangling") && item.blocked !== true,
    );
    printer.hint(
      repairable
        ? `Run \`aireg install${flag}\` to restore what is missing.`
        : `Move what is in the way, or give one artifact another name with \`as:\` in the manifest, then run \`aireg install${flag}\`.`,
    );
  }
}
