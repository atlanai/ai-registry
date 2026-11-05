import type { ReactElement, ReactNode } from "react";
import type { AccountRow } from "#core/console/model.ts";
import { BUILT_IN_VIEWS } from "#core/console/model.ts";
import type { HintKey } from "#core/host/panel.ts";
import { clock, displayWidth, truncate, truncateStart } from "#core/term/format.ts";
import { COLOR, GLYPH } from "#core/term/theme.ts";
import { box, faint, hints, plain, rule, text } from "./elements.ts";
import { VIEW_LABELS } from "./view.ts";

export interface Tab {
  id: string;
  label: string;
}

/** `after` names the tab to follow; anything unknown lands before Settings. */
export function tabsWith(panels: readonly { id: string; label: string; after?: string }[]): Tab[] {
  const tabs: Tab[] = BUILT_IN_VIEWS.map((id) => ({ id, label: VIEW_LABELS[id] }));
  for (const panel of panels) {
    const at = panel.after === undefined ? -1 : tabs.findIndex((tab) => tab.id === panel.after);
    const fallback = Math.max(0, tabs.length - 1);
    tabs.splice(at === -1 ? fallback : at + 1, 0, { id: panel.id, label: panel.label });
  }
  return tabs;
}

export interface Activity {
  label: string;
  /** The newest line the running command printed, shown in the header. */
  line: string | undefined;
  done: boolean;
  failed: boolean;
}

interface Piece {
  width: number;
  node: ReactElement;
}

const piece = (color: string, value: string, bold = false): Piece => ({
  width: displayWidth(value),
  node: text({ color, bold }, value),
});

const widthOf = (pieces: readonly Piece[]) => pieces.reduce((sum, p) => sum + p.width, 0);

/** One line, never wrapped: as the width shrinks the daemon goes first, then the pull. */
export function header(props: {
  width: number;
  activity: Activity | undefined;
  lastPullAtMs: number | undefined;
  daemonRunning: boolean;
  read: string;
}): ReactElement {
  const brand = [piece(COLOR.green, `${GLYPH.active} `), piece(COLOR.white, `aireg console`, true)];
  const pulled =
    props.lastPullAtMs === undefined ? "not pulled yet" : `pulled ${clock(props.lastPullAtMs)}`;
  const pull = [piece(COLOR.dim, `${pulled} · `), piece(COLOR.ink, "u"), piece(COLOR.dim, " pull")];
  const daemon = [
    piece(props.daemonRunning ? COLOR.green : COLOR.faint, GLYPH.bullet),
    piece(COLOR.dim, " daemon · "),
  ];
  const read = [piece(COLOR.dim, props.read)];
  const gap = piece(COLOR.dim, "   ");

  const spare = (pieces: readonly Piece[]) => props.width - widthOf(brand) - 2 - widthOf(pieces);
  const slot = props.activity === undefined ? pull : running(props.activity, spare([gap, ...read]));
  const right =
    [
      [...slot, gap, ...daemon, ...read],
      [...slot, gap, ...read],
    ].find((pieces) => spare(pieces) >= 0) ?? read;

  return box(
    { flexDirection: "column", width: props.width },
    box({ justifyContent: "space-between" }, row(brand), row(right)),
    rule(props.width),
  );
}

/** A running command, in the slot the pull hint takes, with its line cut to `room`. */
function running(activity: Activity, room: number): Piece[] {
  const label = piece(
    activity.failed ? COLOR.red : COLOR.yellow,
    `${GLYPH.spin} ${activity.label}`,
  );
  const cancel = activity.done ? [] : [piece(COLOR.faint, "  esc cancel")];
  const budget = Math.min(48, room - label.width - widthOf(cancel));
  const line = activity.line === undefined || budget < 2 ? "" : truncate(activity.line, budget - 1);
  return [label, piece(COLOR.faint, line === "" ? "" : ` ${line}`), ...cancel];
}

function row(pieces: readonly Piece[]): ReactElement {
  return box(null, ...pieces.map((p) => p.node));
}

/** Rendered width of each registry tab, so a click can be mapped back to one. */
export function accountTabWidths(accounts: readonly AccountRow[]): number[] {
  return accounts.map(
    (account, index) => displayWidth(account.registry) + ` [${index + 1}]    `.length,
  );
}

/** The registries, labeled with the digit that picks each, and the scope's folder. */
export function accountTabs(props: {
  width: number;
  accounts: readonly AccountRow[];
  activeId: string | undefined;
  /** The scope's folder, as the reader would type it. */
  root: string;
}): ReactElement {
  const tabs: ReactNode[] = [];
  for (const [index, account] of props.accounts.entries()) {
    const active = account.id === props.activeId;
    tabs.push(
      text(
        {
          key: account.id,
          color: active ? COLOR.white : COLOR.dim,
          bold: active,
          underline: active,
        },
        account.registry,
      ),
      text({ key: `${account.id}-n`, color: COLOR.faint }, ` [${index + 1}]    `),
    );
  }
  const used = accountTabWidths(props.accounts).reduce((sum, width) => sum + width, 0);
  const room = props.width - used - 2;
  return box(
    { flexDirection: "column", width: props.width },
    box(
      { justifyContent: "space-between" },
      box(null, ...tabs),
      text({ color: COLOR.dim }, room < 2 ? "" : truncateStart(props.root, room)),
    ),
    rule(props.width),
  );
}

/**
 * No digit here: the digits pick a registry. Views move with the arrows, and
 * by clicking.
 */
export function viewTabWidths(tabs: readonly Tab[]): number[] {
  return tabs.map((tab) => tab.label.length + 5);
}

export function viewTabs(tabs: readonly Tab[], active: string): ReactElement {
  const rendered: ReactNode[] = [];
  for (const tab of tabs) {
    const selected = tab.id === active;
    rendered.push(
      text(
        {
          key: tab.id,
          color: selected ? COLOR.white : COLOR.dim,
          bold: selected,
          inverse: selected,
        },
        ` ${tab.label} `,
      ),
      text({ key: `${tab.id}-s` }, "   "),
    );
  }
  return box({ marginBottom: 1 }, ...rendered, text({ color: COLOR.faint }, "  \u2190 \u2192"));
}

export function footer(props: {
  width: number;
  keys: readonly HintKey[];
  right: string;
}): ReactElement {
  return box(
    { flexDirection: "column", width: props.width },
    rule(props.width),
    box({ justifyContent: "space-between" }, hints(props.keys), faint(props.right)),
  );
}

/**
 * The two-line strip under a list. It follows the cursor rather than sitting in
 * a side pane, which is what keeps the list itself full width.
 */
export function summaryStrip(props: {
  width: number;
  title: ReactNode;
  badge: { label: string; color: string } | undefined;
  lines: ReactNode[];
  hint: string | undefined;
}): ReactElement {
  return box(
    { flexDirection: "column", width: props.width },
    rule(props.width),
    box(
      { justifyContent: "space-between" },
      box(
        null,
        text({ color: COLOR.faint }, `${GLYPH.pipe} `),
        text({ color: COLOR.white, bold: true }, props.title),
        props.badge === undefined
          ? plain("")
          : text({ color: props.badge.color, bold: true }, `   ${props.badge.label}`),
      ),
      props.hint === undefined ? plain("") : faint(props.hint),
    ),
    ...props.lines.map((line, index) =>
      box({ key: `l${index}` }, text({ color: COLOR.faint }, `${GLYPH.pipe} `), line),
    ),
  );
}
