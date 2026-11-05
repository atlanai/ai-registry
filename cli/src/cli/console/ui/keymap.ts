import type { Key } from "ink";
import type { BuiltInView, ConsoleState } from "#core/console/model.ts";
import type { HintKey } from "#core/host/panel.ts";

export type Footer = BuiltInView | "panel";

export interface KeyBinding {
  /** `global` keys answer on every view, before the view's own. */
  scope: "global" | readonly BuiltInView[];
  matches(input: string, key: Key, state: ConsoleState): boolean;
  whileFiltering?: true;
  /** Footers list keys in keymap order. */
  footer: Partial<Record<Footer, HintKey>>;
  /** Placed by `HELP`. */
  help: HintKey | undefined;
}

const MOVE: HintKey = { key: "up/down", label: "move" };
const VIEW: HintKey = { key: "left/right", label: "view" };
const RELOAD: HintKey = { key: "g", label: "reload" };
const QUIT: HintKey = { key: "q", label: "quit" };

/** Overlays and the filter name their own keys in what they draw. */
export const KEYMAP = {
  move: {
    scope: "global",
    matches: (input, key) => moveDelta(input, key) !== 0,
    whileFiltering: true,
    footer: { artifacts: MOVE, jobs: MOVE, accounts: MOVE, settings: MOVE, panel: MOVE },
    help: { key: "up down / j k", label: "move" },
  },
  view: {
    scope: "global",
    // Folding a group is `enter` on its header, so left and right only walk the tabs.
    matches: (_input, key) => key.leftArrow || key.rightArrow,
    whileFiltering: true,
    footer: { overview: VIEW, artifacts: VIEW, panel: VIEW },
    help: { key: "left right", label: "previous or next view" },
  },
  // The digits match the labels on the registry tabs; one past the last falls to the view.
  "pick-registry": {
    scope: "global",
    matches: (input, _key, state) =>
      state.accounts[Number(input) - 1] !== undefined && input >= "1" && input <= "9",
    footer: {
      overview: { key: "1-9 / tab", label: "registry" },
      artifacts: { key: "1-9", label: "registry" },
    },
    help: { key: "1 - 9", label: "switch registry" },
  },
  "next-registry": {
    scope: "global",
    matches: (_input, key) => key.tab,
    footer: { accounts: { key: "tab", label: "next registry" } },
    help: { key: "tab", label: "next registry" },
  },
  fold: {
    scope: ["artifacts"],
    matches: (input) => input === "h" || input === "l",
    footer: { artifacts: { key: "h/l", label: "fold" } },
    help: { key: "h l", label: "fold or unfold a group" },
  },
  enter: {
    scope: ["overview", "artifacts"],
    matches: (_input, key) => key.return,
    footer: { artifacts: { key: "enter", label: "detail" } },
    help: { key: "enter", label: "expand detail, or confirm" },
  },
  publish: {
    scope: ["artifacts"],
    matches: (input) => input === "p",
    footer: { artifacts: { key: "p", label: "publish" } },
    help: { key: "p", label: "publish a group, or the edited row" },
  },
  "run-job": {
    scope: ["jobs"],
    matches: (input) => input === "R",
    footer: { jobs: { key: "R", label: "run now" } },
    help: { key: "R", label: "run a job now" },
  },
  "retry-run": {
    scope: ["jobs"],
    matches: (input) => input === "r",
    footer: { jobs: { key: "r", label: "retry" } },
    help: { key: "r", label: "retry a failed run" },
  },
  "toggle-job": {
    scope: ["jobs"],
    matches: (input) => input === " ",
    footer: { jobs: { key: "space", label: "enable/disable" } },
    help: { key: "space", label: "enable or disable a job" },
  },
  pull: {
    scope: "global",
    matches: (input) => input === "u",
    footer: {
      overview: { key: "u", label: "pull latest" },
      artifacts: { key: "u", label: "pull latest" },
    },
    help: { key: "u", label: "pull latest from the registry" },
  },
  filter: {
    scope: ["artifacts"],
    matches: (input) => input === "/",
    footer: { artifacts: { key: "/", label: "filter" } },
    help: { key: "/", label: "filter" },
  },
  reload: {
    scope: "global",
    matches: (input) => input === "g",
    footer: { overview: RELOAD, jobs: RELOAD, accounts: RELOAD, settings: RELOAD, panel: RELOAD },
    help: { key: "g", label: "reload" },
  },
  help: {
    scope: "global",
    matches: (input) => input === "?",
    footer: { overview: { key: "?", label: "keys" } },
    help: { key: "? q", label: "keys, quit" },
  },
  quit: {
    scope: "global",
    matches: (input, key) => input === "q" || (key.ctrl && input === "c"),
    footer: { overview: QUIT, settings: QUIT },
    // Shares the help line of `?`.
    help: undefined,
  },
  // Its hint names the upstream's app, so `footerKeys` adds it only when there is one.
  open: {
    scope: "global",
    matches: (input) => input === "o",
    footer: {},
    help: undefined,
  },
} as const satisfies Record<string, KeyBinding>;

export type KeyCommand = keyof typeof KEYMAP;

export type GlobalCommand = {
  [C in KeyCommand]: (typeof KEYMAP)[C]["scope"] extends "global" ? C : never;
}[KeyCommand];

export type ViewCommand = Exclude<KeyCommand, GlobalCommand>;

const COMMANDS = Object.keys(KEYMAP) as KeyCommand[];

/** `filtering` keeps only the keys that work while typing. */
export function globalCommandFor(
  input: string,
  key: Key,
  context: { state: ConsoleState; filtering: boolean },
): GlobalCommand | undefined {
  return COMMANDS.find((command): command is GlobalCommand => {
    const binding: KeyBinding = KEYMAP[command];
    return (
      binding.scope === "global" &&
      (!context.filtering || binding.whileFiltering === true) &&
      binding.matches(input, key, context.state)
    );
  });
}

export function viewCommandFor(
  view: BuiltInView,
  input: string,
  key: Key,
  state: ConsoleState,
): ViewCommand | undefined {
  return COMMANDS.find((command): command is ViewCommand => {
    const binding: KeyBinding = KEYMAP[command];
    return (
      binding.scope !== "global" &&
      binding.scope.includes(view) &&
      binding.matches(input, key, state)
    );
  });
}

export function moveDelta(input: string, key: Key): number {
  if (key.upArrow || input === "k") return -1;
  if (key.downArrow || input === "j") return 1;
  if (key.pageUp) return -10;
  if (key.pageDown) return 10;
  return 0;
}

/** `declared` is only what a panel says it answers, so the footer never offers a key it cannot. */
export function footerKeys(
  footer: Footer,
  declared: readonly HintKey[],
  app: string | undefined,
): HintKey[] {
  const own = COMMANDS.flatMap((command) => {
    const binding: KeyBinding = KEYMAP[command];
    const hint = binding.footer[footer];
    return hint === undefined ? [] : [hint];
  });
  return [
    ...own,
    ...declared,
    ...(app === undefined ? [] : [{ key: "o", label: `open in ${app}` }]),
  ];
}

type HelpedCommand = {
  [C in KeyCommand]: (typeof KEYMAP)[C]["help"] extends HintKey ? C : never;
}[KeyCommand];

const HELP: readonly (HelpedCommand | HintKey)[] = [
  "view",
  "pick-registry",
  { key: "click", label: "a tab, or a row" },
  { key: "wheel", label: "scroll" },
  "next-registry",
  "pull",
  "publish",
  "move",
  "fold",
  "enter",
  "run-job",
  "retry-run",
  "toggle-job",
  "filter",
  "reload",
  "help",
];

export function helpKeys(declared: readonly HintKey[]): HintKey[] {
  const own = HELP.map((line) => (typeof line === "string" ? KEYMAP[line].help : line));
  return [...own, ...declared];
}
