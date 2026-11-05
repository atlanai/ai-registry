import type { Dispatch } from "react";
import { accountTabWidths, type Tab, viewTabWidths } from "./chrome.ts";
import { LAYOUT, type MouseEvent, tabAt, useMouse } from "./mouse.ts";
import type { UiAction } from "./reducer.ts";
import { cursorMoved, type Screen, type ViewFrame } from "./screen.ts";
import type { ConsoleData } from "./use-data.ts";

export interface PointerOptions {
  frame: ViewFrame;
  screen: Screen;
  tabs: readonly Tab[];
  data: ConsoleData;
  dispatch: Dispatch<UiAction>;
}

export function usePointer(options: PointerOptions): void {
  const { frame, screen, dispatch } = options;
  const { ui } = frame;
  useMouse((event) => {
    if (event.kind === "wheel-up" || event.kind === "wheel-down") {
      dispatch(cursorMoved(ui.view, screen, event.kind === "wheel-up" ? -3 : 3));
      return;
    }
    if (event.kind !== "press" || ui.overlay.kind !== "none" || ui.activity !== undefined) return;
    if (clickedTab(options, event)) return;
    const index = screen.rowAt(event.row);
    if (index !== undefined) dispatch({ type: "set-cursor", view: ui.view, index });
  });
}

function clickedTab(options: PointerOptions, event: MouseEvent): boolean {
  const { frame, tabs, data, dispatch } = options;
  const { state } = frame;
  if (event.row === LAYOUT.viewTabs) {
    const index = tabAt(event.column, viewTabWidths(tabs), 0);
    const next = index === undefined ? undefined : tabs[index];
    if (next !== undefined) dispatch({ type: "show-view", view: next.id });
    return true;
  }
  if (event.row !== LAYOUT.accountTabs) return false;
  const index = tabAt(event.column, accountTabWidths(state.accounts), 0);
  const next = index === undefined ? undefined : state.accounts[index];
  if (next !== undefined && next.id !== state.account?.id) data.selectAccount(next.id);
  return true;
}
