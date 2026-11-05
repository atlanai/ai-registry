import type { ReactNode } from "react";
import { messageOf } from "#adapter/errors.ts";
import * as commands from "#core/console/actions.ts";
import type { PanelNode, PanelView } from "#core/host/panel.ts";
import { COLOR } from "#core/term/theme.ts";
import { box, faint, text } from "./elements.ts";
import { listRowAt } from "./mouse.ts";
import { clamped, type Screen, type ViewActions, type ViewFrame } from "./screen.ts";
import { toolkit } from "./toolkit.ts";
import type { AnyPanel } from "./view.ts";

/** Measured at zero first: the cursor needs a length, and a length needs a view. */
export function panelScreen(panel: AnyPanel, frame: ViewFrame, actions: ViewActions): Screen {
  const collected = frame.state.panels[panel.id];
  const length = collected === undefined ? 0 : counted(panel, panelViewAt(frame, panel.id, 0));
  const cursor = clamped(frame.ui.cursors[panel.id], length);
  const view = collected === undefined ? undefined : panelViewAt(frame, panel.id, cursor);
  const { prefetch } = panel;
  return {
    footer: "panel",
    length,
    cursor,
    body: () =>
      view === undefined
        ? unreadable(
            panel.label,
            frame.state.problems.find((problem) => problem.startsWith(`${panel.label}: `)),
          )
        : attempt(panel.label, () => panel.render(view)),
    strip: () =>
      view === undefined ? null : attempt(panel.label, () => panel.strip?.(view) ?? null),
    rowAt: (screenRow) =>
      length === 0 || panel.listTop === undefined
        ? undefined
        : listRowAt(screenRow, { top: panel.listTop, total: length, cursor, height: frame.height }),
    onKey(input) {
      if (panel.onKey === undefined || view === undefined) return;
      panel.onKey(input, {
        view,
        setFlag: (name, value) =>
          actions.dispatch({ type: "set-flag", panel: panel.id, name, value }),
        run: actions.run,
        open: commands.open,
        reload: actions.reload,
      });
    },
    link: () => {
      if (view === undefined) return undefined;
      try {
        return panel.link?.(view);
      } catch {
        // A panel that throws only has no link to open.
        return undefined;
      }
    },
    declaredKeys: panel.keys ?? [],
    prefetch: prefetch === undefined || view === undefined ? undefined : () => prefetch(view),
  };
}

export function panelBlocks(
  panels: readonly AnyPanel[],
  frame: ViewFrame,
  pick: "overview" | "settings",
): ReactNode[] {
  return panels.flatMap((contribution) => {
    const data = frame.state.panels[contribution.id];
    const draw = contribution[pick];
    if (draw === undefined || data === undefined) return [];
    const node = attempt(contribution.label, () => draw(panelViewAt(frame, contribution.id, 0)));
    return node === undefined || node === null ? [] : [node];
  });
}

/** A panel gets the toolkit and its own slice of the state, nothing else. */
// biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
function panelViewAt(frame: ViewFrame, id: string, cursor: number): PanelView<any> {
  return {
    width: frame.width,
    height: frame.height,
    cursor,
    nowMs: frame.nowMs,
    state: frame.state,
    data: frame.state.panels[id],
    flags: frame.ui.flags[id] ?? {},
    facts: frame.facts,
    ui: toolkit,
  };
}

function counted(panel: AnyPanel, view: PanelView): number {
  try {
    const length = panel.length(view);
    return Number.isInteger(length) && length >= 0 ? length : 0;
  } catch {
    // A panel that throws draws its own error instead of taking the console down.
    return 0;
  }
}

/**
 * A panel is third-party code inside our render tree, and Ink has no error boundary:
 * an exception in one takes the whole console with it.
 */
function attempt(label: string, draw: () => PanelNode): ReactNode {
  try {
    return draw() as ReactNode;
  } catch (error) {
    return unreadable(label, messageOf(error));
  }
}

/** A tab whose adapter could not answer, or threw while drawing. */
function unreadable(label: string, why: string | undefined): ReactNode {
  return box(
    { flexDirection: "column", marginTop: 1 },
    text({ color: COLOR.orange }, `  ${label} could not be read.`),
    faint(`  ${why ?? "The adapter that provides this tab did not answer."}`),
  );
}
