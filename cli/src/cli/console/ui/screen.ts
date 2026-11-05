import type { Key } from "ink";
import type { Dispatch, ReactNode } from "react";
import { step } from "#cli/console/data/list.ts";
import type { BuiltInView, ConsoleState } from "#core/console/model.ts";
import type { HintKey, LinkFacts, UpstreamContribution } from "#core/host/panel.ts";
import { type Footer, type ViewCommand, viewCommandFor } from "./keymap.ts";
import type { UiAction, UiState } from "./reducer.ts";
import type { RunCommand } from "./use-commands.ts";

export interface ViewFrame {
  width: number;
  /** Rows a list may draw, after the chrome takes its share. */
  height: number;
  state: ConsoleState;
  ui: UiState;
  nowMs: number;
  facts: LinkFacts;
  upstream: UpstreamContribution | undefined;
  blocks(pick: "overview" | "settings"): ReactNode[];
}

export interface ViewActions {
  dispatch: Dispatch<UiAction>;
  run: RunCommand;
  reload(): void;
}

export interface Screen {
  footer: Footer;
  length: number;
  cursor: number;
  body(): ReactNode;
  strip(): ReactNode;
  rowAt(screenRow: number): number | undefined;
  /** A key no global binding took. */
  onKey(input: string, key: Key): void;
  /** Where `o` goes before the registry's own page. */
  link(): string | undefined;
  /** Beyond the keymap's, for the footer and the help overlay. */
  declaredKeys: readonly HintKey[];
  prefetch: (() => Promise<boolean>) | undefined;
}

export interface Shown<M> {
  frame: ViewFrame;
  model: M;
  cursor: number;
}

type ViewKeyHandler<M> = (shown: Shown<M>, actions: ViewActions, input: string) => void;

export interface ViewDefinition<M> {
  model(frame: ViewFrame): M;
  length(model: M): number;
  body(shown: Shown<M>): ReactNode;
  strip?(shown: Shown<M>): ReactNode;
  rowAt?(shown: Shown<M>, screenRow: number): number | undefined;
  link?(shown: Shown<M>): string | undefined;
  keys: Partial<Record<ViewCommand, ViewKeyHandler<M>>>;
}

export interface BuiltInScreen {
  id: BuiltInView;
  /** The keymap's scopes must agree with these. */
  handles: readonly ViewCommand[];
  open(frame: ViewFrame, actions: ViewActions): Screen;
}

export function defineView<M>(id: BuiltInView, definition: ViewDefinition<M>): BuiltInScreen {
  return {
    id,
    handles: Object.keys(definition.keys) as ViewCommand[],
    open(frame, actions) {
      const model = definition.model(frame);
      const length = definition.length(model);
      const shown: Shown<M> = { frame, model, cursor: clamped(frame.ui.cursors[id], length) };
      return {
        footer: id,
        length,
        cursor: shown.cursor,
        body: () => definition.body(shown),
        strip: () => definition.strip?.(shown) ?? null,
        rowAt: (screenRow) => (length === 0 ? undefined : definition.rowAt?.(shown, screenRow)),
        onKey(input, key) {
          const command = viewCommandFor(id, input, key, frame.state);
          if (command !== undefined) definition.keys[command]?.(shown, actions, input);
        },
        link: () => definition.link?.(shown),
        declaredKeys: [],
        prefetch: undefined,
      };
    },
  };
}

export function clamped(cursor: number | undefined, length: number): number {
  return Math.min(cursor ?? 0, Math.max(0, length - 1));
}

export function cursorMoved(view: string, screen: Screen, delta: number): UiAction {
  return { type: "set-cursor", view, index: step(screen.cursor, delta, screen.length) };
}
