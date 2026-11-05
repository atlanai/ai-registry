import { type Key, useInput } from "ink";
import type { Dispatch } from "react";
import * as commands from "#core/console/actions.ts";
import type { Tab } from "./chrome.ts";
import { type GlobalCommand, globalCommandFor, moveDelta } from "./keymap.ts";
import { importNow, planForRow, runPlan } from "./publish.ts";
import type { Activity, Overlay, UiAction } from "./reducer.ts";
import { cursorMoved, type Screen, type ViewFrame } from "./screen.ts";
import type { RunCommand } from "./use-commands.ts";
import type { ConsoleData } from "./use-data.ts";

export interface KeyboardOptions {
  frame: ViewFrame;
  screen: Screen;
  tabs: readonly Tab[];
  data: ConsoleData;
  dispatch: Dispatch<UiAction>;
  run: RunCommand;
  exit: () => void;
}

type KeyHandler = (input: string, key: Key) => void;

/** The filter, a running command or an overlay owns the keyboard while up; else global keys, then the view's. */
export function useKeyboard(options: KeyboardOptions): void {
  const { frame, screen } = options;
  const { ui, state } = frame;
  const global = globalHandlers(options);
  useInput((input, key) => {
    if (ui.filtering) {
      onFilterKey(options, global, input, key);
      return;
    }
    if (ui.activity !== undefined) {
      onActivityKey(options, ui.activity, input, key);
      return;
    }
    if (ui.overlay.kind !== "none") {
      onOverlayKey(options, ui.overlay, input, key);
      return;
    }
    const command = globalCommandFor(input, key, { state, filtering: false });
    if (command === undefined) screen.onKey(input, key);
    else global[command](input, key);
  });
}

function globalHandlers(options: KeyboardOptions): Record<GlobalCommand, KeyHandler> {
  const { frame, screen, tabs, data, dispatch, run, exit } = options;
  const { state, ui } = frame;
  return {
    move: (input, key) => dispatch(cursorMoved(ui.view, screen, moveDelta(input, key))),
    view: (_input, key) => {
      const index = tabs.findIndex((tab) => tab.id === ui.view);
      const next = tabs[(index + (key.leftArrow ? -1 : 1) + tabs.length) % tabs.length];
      if (next !== undefined) dispatch({ type: "show-view", view: next.id });
    },
    "pick-registry": (input) => {
      const account = state.accounts[Number(input) - 1];
      if (account !== undefined && account.id !== state.account?.id) {
        data.selectAccount(account.id);
      }
    },
    "next-registry": () => {
      const index = state.accounts.findIndex((row) => row.id === state.account?.id);
      const next = state.accounts[(index + 1) % Math.max(1, state.accounts.length)];
      if (next !== undefined) data.selectAccount(next.id);
    },
    pull: () => run("pull latest", commands.pullLatest(state.account?.registry, state.scope)),
    reload: () => void data.reload(),
    help: () => dispatch({ type: "show-overlay", overlay: { kind: "help" } }),
    quit: () => exit(),
    open: () => {
      const url = screen.link() ?? frame.upstream?.registry?.(frame.facts);
      if (url !== undefined) commands.open(url);
    },
  };
}

function onFilterKey(
  options: KeyboardOptions,
  global: Record<GlobalCommand, KeyHandler>,
  input: string,
  key: Key,
): void {
  const { frame, dispatch } = options;
  const command = globalCommandFor(input, key, { state: frame.state, filtering: true });
  if (command !== undefined) global[command](input, key);
  else if (key.escape) dispatch({ type: "clear-filter" });
  else if (key.return) dispatch({ type: "close-filter" });
  else if (key.backspace || key.delete) dispatch({ type: "erase-filter" });
  else if (input !== "" && !key.ctrl && !key.meta) dispatch({ type: "type-filter", text: input });
}

function onActivityKey(options: KeyboardOptions, activity: Activity, input: string, key: Key) {
  if (!key.escape && input !== "q") return;
  if (activity.done) options.dispatch({ type: "close-activity" });
  else activity.cancel();
}

function onOverlayKey(options: KeyboardOptions, overlay: Overlay, input: string, key: Key): void {
  const { frame, dispatch, run } = options;
  const close = () => dispatch({ type: "show-overlay", overlay: { kind: "none" } });
  if (key.escape || input === "q") {
    close();
    return;
  }
  if (overlay.kind === "publish" && key.return) {
    close();
    runPlan(overlay.plan, frame.state, run);
    return;
  }
  if (overlay.kind !== "detail") return;
  if (input === "p") {
    const plan = importNow(overlay.row, run) ? undefined : planForRow(overlay.row, frame);
    dispatch({
      type: "show-overlay",
      overlay: plan === undefined ? { kind: "none" } : { kind: "publish", plan },
    });
    return;
  }
  if (input === "o") {
    const url = frame.upstream?.artifact?.(frame.facts, overlay.row);
    if (url !== undefined) commands.open(url);
  }
}
