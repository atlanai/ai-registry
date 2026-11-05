import type { Command } from "#core/console/actions.ts";
import type { ArtifactRow } from "#core/console/model.ts";
import { type PublishPlan, withLine } from "./overlays.ts";

export type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "detail"; row: ArtifactRow }
  | { kind: "publish"; plan: PublishPlan };

export interface Activity {
  label: string;
  startedAtMs: number;
  command: Command;
  lines: string[];
  done: boolean;
  code: number | undefined;
  /** Undefined until the reload runs; empty means nothing here moved. */
  changed: string[] | undefined;
  cancel: () => void;
}

export interface UiState {
  /** Also the key cursors and flags are filed under. */
  view: string;
  /** Clamped when drawn, so a reload that shortens the list keeps the cursor on it. */
  cursors: Readonly<Record<string, number>>;
  folded: ReadonlySet<string>;
  filter: string;
  /** While open it owns the keyboard, or typing "p" publishes. */
  filtering: boolean;
  /** Held here so a reload keeps them. */
  flags: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  overlay: Overlay;
  activity: Activity | undefined;
}

export type UiAction =
  | { type: "show-view"; view: string }
  | { type: "set-cursor"; view: string; index: number }
  | { type: "open-namespace"; filter: string }
  | { type: "fold"; group: string; folded: boolean }
  | { type: "open-filter" }
  | { type: "type-filter"; text: string }
  | { type: "erase-filter" }
  | { type: "close-filter" }
  | { type: "clear-filter" }
  | { type: "set-flag"; panel: string; name: string; value: boolean }
  | { type: "show-overlay"; overlay: Overlay }
  | { type: "start-activity"; activity: Activity }
  | { type: "print-activity"; line: string }
  | { type: "finish-activity"; code: number }
  | { type: "compare-activity"; changed: string[] }
  | { type: "close-activity" };

export const INITIAL_UI: UiState = {
  view: "overview",
  cursors: {},
  folded: new Set(),
  filter: "",
  filtering: false,
  flags: {},
  overlay: { kind: "none" },
  activity: undefined,
};

export function reduceUi(ui: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "show-view":
      return { ...ui, view: action.view };
    case "set-cursor":
      return { ...ui, cursors: { ...ui.cursors, [action.view]: action.index } };
    case "open-namespace":
      return {
        ...ui,
        filter: action.filter,
        view: "artifacts",
        cursors: { ...ui.cursors, artifacts: 0 },
      };
    case "fold":
      return { ...ui, folded: folded(ui.folded, action.group, action.folded) };
    case "open-filter":
      return { ...ui, filtering: true };
    case "type-filter":
      return { ...ui, filter: ui.filter + action.text };
    case "erase-filter":
      return { ...ui, filter: ui.filter.slice(0, -1) };
    case "close-filter":
      return { ...ui, filtering: false };
    case "clear-filter":
      return { ...ui, filtering: false, filter: "" };
    case "set-flag":
      return {
        ...ui,
        flags: {
          ...ui.flags,
          [action.panel]: { ...ui.flags[action.panel], [action.name]: action.value },
        },
      };
    case "show-overlay":
      return { ...ui, overlay: action.overlay };
    case "start-activity":
      return { ...ui, activity: action.activity };
    case "print-activity":
      return withActivity(ui, (activity) => ({
        ...activity,
        lines: withLine(activity.lines, action.line),
      }));
    case "finish-activity":
      return withActivity(ui, (activity) => ({ ...activity, done: true, code: action.code }));
    case "compare-activity":
      return withActivity(ui, (activity) => ({ ...activity, changed: action.changed }));
    case "close-activity":
      return { ...ui, activity: undefined };
  }
}

function folded(current: ReadonlySet<string>, group: string, fold: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (fold) next.add(group);
  else next.delete(group);
  return next;
}

/** A closed activity stays closed: its child can still print, and its reload land, after it. */
function withActivity(ui: UiState, change: (activity: Activity) => Activity): UiState {
  return ui.activity === undefined ? ui : { ...ui, activity: change(ui.activity) };
}
