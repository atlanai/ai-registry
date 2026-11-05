import type { ReactElement, ReactNode } from "react";
import { windowAround } from "#cli/console/data/list.ts";
import { groupTag, summaryStrip } from "#cli/console/ui/chrome.ts";
import { action, box, dim, faint, plain, text } from "#cli/console/ui/elements.ts";
import { LAYOUT, listRowAt } from "#cli/console/ui/mouse.ts";
import { importNow, planForLine } from "#cli/console/ui/publish.ts";
import { defineView, type Shown, type ViewActions } from "#cli/console/ui/screen.ts";
import { publishable } from "#core/console/artifacts.ts";
import { flatten, type Line, lineKey } from "#core/console/flatten.ts";
import type { ArtifactGroup, ArtifactRow, ConsoleState } from "#core/console/model.ts";
import { stateStyle } from "#core/console/state-style.ts";
import { ago, pad, shortDigest, truncate } from "#core/term/format.ts";
import { COLOR, GLYPH } from "#core/term/theme.ts";

type Model = ReturnType<typeof flatten>;

// Under the list: the filter, a blank, then the column heading.
const LIST_TOP = LAYOUT.body + 3;

export const ARTIFACTS_VIEW = defineView<Model>("artifacts", {
  model: ({ state, ui }) =>
    flatten(state.groups, { folded: ui.folded, filter: ui.filter, only: undefined }),
  length: (model) => model.lines.length,
  body: ({ frame, model, cursor }) =>
    box(
      { flexDirection: "column" },
      artifactsView({
        width: frame.width,
        height: frame.height,
        state: frame.state,
        lines: model.lines,
        shown: model.shown,
        cursor,
        folded: frame.ui.folded,
        filter: frame.ui.filter,
        filtering: frame.ui.filtering,
        nowMs: frame.nowMs,
      }),
    ),
  strip: ({ frame, model, cursor }) =>
    artifactsSummary({ width: frame.width, line: model.lines[cursor], nowMs: frame.nowMs }),
  rowAt: ({ frame, model, cursor }, screenRow) =>
    listRowAt(screenRow, {
      top: LIST_TOP,
      total: model.lines.length,
      cursor,
      height: frame.height,
    }),
  // The routes are the adapter's; which row is selected is not.
  link: ({ frame, model, cursor }) => {
    const line = model.lines[cursor];
    if (line === undefined) return undefined;
    return line.kind === "artifact"
      ? frame.upstream?.artifact?.(frame.facts, line.row)
      : frame.upstream?.namespace?.(frame.facts, line.group.key);
  },
  keys: {
    filter: (_shown, { dispatch }) => dispatch({ type: "open-filter" }),
    publish: publishSelected,
    enter: ({ frame, model, cursor }, { dispatch }) => {
      const line = model.lines[cursor];
      if (line === undefined) return;
      if (line.kind === "artifact") {
        dispatch({ type: "show-overlay", overlay: { kind: "detail", row: line.row } });
        return;
      }
      const group = line.group.key;
      dispatch({ type: "fold", group, folded: !frame.ui.folded.has(group) });
    },
    fold: ({ model, cursor }, { dispatch }, input) => {
      const group = model.lines[cursor]?.group;
      if (group !== undefined) dispatch({ type: "fold", group: group.key, folded: input === "h" });
    },
  },
});

// aireg never publishes to a git registry; its rows already say where an edit goes.
function publishSelected({ frame, model, cursor }: Shown<Model>, actions: ViewActions): void {
  if (frame.state.account?.publishes === false) return;
  const line = model.lines[cursor];
  if (line?.kind === "artifact" && importNow(line.row, actions.run)) return;
  const plan = planForLine(line, frame);
  if (plan === undefined) return;
  actions.dispatch({ type: "show-overlay", overlay: { kind: "publish", plan } });
}

interface Columns {
  name: number;
  version: number;
  targets: number;
  state: number;
  changed: number;
}

function artifactsView(props: {
  width: number;
  height: number;
  state: ConsoleState;
  lines: readonly Line[];
  shown: number;
  cursor: number;
  folded: ReadonlySet<string>;
  filter: string;
  filtering: boolean;
  nowMs: number;
}): ReactElement {
  const cols = columns(props.width);
  const publishes = props.state.account?.publishes !== false;
  const listHeight = Math.max(3, props.height);
  const view = windowAround(props.lines.length, props.cursor, listHeight);
  const rows: ReactElement[] = [];
  for (let index = view.from; index < view.to; index += 1) {
    const line = props.lines[index];
    if (line === undefined) continue;
    const selected = index === props.cursor;
    rows.push(
      box(
        { key: lineKey(line) },
        line.kind === "group"
          ? groupLine(line.group, props.folded.has(line.group.key), selected, cols, publishes)
          : artifactLine(line.row, selected, cols, props.nowMs, publishes),
      ),
    );
  }

  return box(
    { flexDirection: "column", width: props.width },
    box(
      { justifyContent: "space-between" },
      box(
        null,
        text({ color: props.filtering ? COLOR.yellow : COLOR.dim }, "/ "),
        props.filter === "" && !props.filtering
          ? faint("filter…")
          : text({ color: COLOR.white }, `${props.filter}${props.filtering ? "█" : ""}`),
      ),
      tally(props.state),
    ),
    box(
      { marginTop: 1 },
      faint(
        `  ${pad("NAME", cols.name)}${pad("VERSION", cols.version)}${pad("TARGETS", cols.targets)}` +
          `${pad("STATE", cols.state)}${pad("CHANGED", cols.changed)}`,
      ),
    ),
    ...rows,
    view.below > 0 ? box(null, faint(`  … ${view.below} more below`)) : box(null, plain("")),
  );
}

/** Reserved on the right for `[p] publish N`, so nothing collides with it. */
const ACTION_COLUMN = 24;

/**
 * The name takes what the fixed columns leave: a truncated version or target list is
 * useless where a truncated name is still recognizable.
 */
function columns(width: number): Columns {
  const fixed = { version: 12, targets: 20, state: 14, changed: 18 };
  const spent = Object.values(fixed).reduce((total, value) => total + value, 0);
  return { ...fixed, name: Math.max(16, width - 4 - ACTION_COLUMN - spent) };
}

function groupLine(
  group: ArtifactGroup,
  folded: boolean,
  selected: boolean,
  cols: Columns,
  publishes: boolean,
): ReactElement {
  const ready = publishable(group).length;
  return box(
    {
      width: "100%",
      justifyContent: "space-between",
      ...(selected ? { backgroundColor: COLOR.selection } : {}),
    },
    box(
      null,
      text({ color: COLOR.yellow }, `${folded ? GLYPH.folded : GLYPH.open} `),
      text({ color: COLOR.white, bold: true }, pad(group.label, cols.name)),
      dim(pad(`${group.rows.length} artifacts`, cols.version + 4)),
      groupTag(group, cols.targets),
      counts(group),
    ),
    publishes
      ? action("p", group.authoredHere ? "publish all" : `publish ${ready}`, ready > 0)
      : plain(""),
  );
}

function counts(group: ArtifactGroup): ReactElement {
  const parts: ReactNode[] = [];
  for (const [state, count] of Object.entries(group.counts)) {
    if (count === 0 || state === "ok") continue;
    const style = stateStyle(state as keyof typeof group.counts);
    parts.push(text({ key: state, color: style.color }, `${count} ${state}  `));
  }
  if (parts.length === 0) parts.push(text({ key: "ok", color: COLOR.green }, "ok"));
  return box(null, ...parts);
}

function artifactLine(
  row: ArtifactRow,
  selected: boolean,
  cols: Columns,
  nowMs: number,
  publishes: boolean,
): ReactElement {
  const style = stateStyle(row.state);
  // `duplicate` looks like local work and is not: push refuses it. Imported work
  // is already where it belongs until it is edited.
  const canPublish = row.state === "edited" || row.state === "unpublished";
  return box(
    {
      width: "100%",
      justifyContent: "space-between",
      ...(selected ? { backgroundColor: COLOR.selection } : {}),
    },
    box(
      null,
      text({ color: style.color }, `  ${style.glyph} `),
      text({ color: COLOR.white }, pad(row.name, cols.name)),
      dim(pad(row.version ?? "-", cols.version)),
      dim(pad(row.targets.join(", ") || "-", cols.targets)),
      text({ color: style.color }, pad(row.state, cols.state)),
      text(
        { color: row.state === "edited" ? COLOR.yellow : COLOR.faint },
        pad(
          row.state === "edited"
            ? `edited ${ago(row.changedAtMs, nowMs)}`
            : ago(row.changedAtMs, nowMs),
          cols.changed,
        ),
      ),
    ),
    rowAction(row, publishes, canPublish),
  );
}

function rowAction(row: ArtifactRow, publishes: boolean, canPublish: boolean): ReactElement {
  if (!publishes) return row.state === "edited" ? faint("publish into your clone") : plain("");
  if (canPublish) return action("p", row.carriedBy === undefined ? "publish" : "import now");
  return row.state === "duplicate" ? faint("rename to publish") : plain("");
}

function tally(state: ConsoleState): ReactElement {
  const s = state.summary;
  const parts: [string, number, string][] = [
    [
      "ok",
      s.skillsImported - s.edited - s.failed - s.dangling - s.missing - s.pending,
      COLOR.green,
    ],
    ["edited", s.edited, COLOR.yellow],
    ["failed", s.failed, COLOR.red],
    ["pending", s.pending, COLOR.yellow],
    ["dangling", s.dangling, COLOR.orange],
    ["missing", s.missing, COLOR.orange],
    ["imported", s.imported, COLOR.green],
    ["local", s.unpublished, COLOR.dim],
    ["duplicate", s.duplicate, COLOR.faint],
  ];
  return box(
    null,
    ...parts
      .filter(([, count]) => count > 0)
      .map(([label, count, color]) => text({ key: label, color }, `${count} ${label}  `)),
  );
}

function artifactsSummary(props: {
  width: number;
  line: Line | undefined;
  nowMs: number;
}): ReactElement {
  const { line } = props;
  if (line === undefined) {
    return summaryStrip({
      width: props.width,
      title: "Nothing selected",
      badge: undefined,
      lines: [],
      hint: undefined,
    });
  }
  if (line.kind === "group") {
    const ready = publishable(line.group);
    return summaryStrip({
      width: props.width,
      title: line.group.label,
      badge: line.group.isDefault ? { label: "DEFAULT", color: COLOR.yellow } : undefined,
      lines: [
        box(
          null,
          dim(`${line.group.rows.length} artifacts  `),
          dim(`versions `),
          text({ color: COLOR.white }, truncate(line.group.versions.join(", "), props.width - 40)),
          ready.length === 0
            ? faint("   nothing to publish")
            : text({ color: COLOR.yellow }, `   ${ready.length} ready to publish`),
        ),
      ],
      hint: "enter to expand",
    });
  }
  const row = line.row;
  const style = stateStyle(row.state);
  // A row the registry refused has no id, digest or version, so the strip
  // carries the reason instead of a run of dashes.
  const facts: ReactNode[] =
    row.id === ""
      ? [
          faint(
            row.registry === "" ? "listed by the catalog, never fetched  " : `${row.registry}  `,
          ),
        ]
      : [
          dim("id "),
          text({ color: COLOR.white }, `${truncate(row.id, 26)}  `),
          dim("version "),
          text({ color: COLOR.white }, `${row.version ?? "\u2014"}  `),
          dim("lockfile "),
          faint(`${shortDigest(row.lockDigest)}  `),
          dim("local "),
          text(
            { color: row.state === "edited" ? COLOR.yellow : COLOR.faint },
            `${shortDigest(row.diskDigest)}  `,
          ),
        ];
  return summaryStrip({
    width: props.width,
    title: `${row.namespace ?? "this machine"} / ${row.name}`,
    badge: { label: row.state.toUpperCase(), color: style.color },
    lines: [
      box(
        null,
        ...facts,
        row.detail === undefined
          ? plain("")
          : text({ color: style.color }, `\u00b7  ${truncate(row.detail, props.width - 60)}`),
      ),
    ],
    hint: "enter to expand",
  });
}
