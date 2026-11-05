import type { Key } from "ink";
import { describe, expect, test } from "vitest";
import { BUILT_IN_SCREENS } from "#cli/console/ui/views/built-in.ts";
import type { AccountRow, ConsoleState } from "#core/console/model.ts";
import { BUILT_IN_VIEWS } from "#core/console/model.ts";
import {
  type Footer,
  footerKeys,
  globalCommandFor,
  helpKeys,
  KEYMAP,
  type KeyBinding,
  type KeyCommand,
  viewCommandFor,
} from "./keymap.ts";

const COMMANDS = Object.keys(KEYMAP) as KeyCommand[];
const FOOTERS: readonly Footer[] = [...BUILT_IN_VIEWS, "panel"];

type Pressed = Partial<Record<"ctrl" | "return" | "rightArrow", boolean>>;

function key(pressed: Pressed = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...pressed,
  };
}

const state = { accounts: [{ id: "acc_1" } as AccountRow] } as ConsoleState;
const keys = (hints: readonly { key: string; label: string }[]) =>
  hints.map((hint) => `${hint.key} ${hint.label}`);

describe("KEYMAP", () => {
  test("binds no key without showing it in the help overlay or a footer", () => {
    const helped = new Set(keys(helpKeys([])));
    const unshown = COMMANDS.filter((command) => {
      const binding: KeyBinding = KEYMAP[command];
      const inHelp = binding.help !== undefined && helped.has(keys([binding.help]).join());
      return !inHelp && Object.keys(binding.footer).length === 0;
    });
    // `o` is named by the footer whenever an upstream gives it somewhere to go.
    expect(unshown).toEqual(["open"]);
    expect(footerKeys("jobs", [], "Acme")).toContainEqual({ key: "o", label: "open in Acme" });
  });

  test("shows a view's key in its footer only where the key is bound", () => {
    for (const command of COMMANDS) {
      const { scope, footer }: KeyBinding = KEYMAP[command];
      for (const shown of Object.keys(footer)) {
        const bound = scope === "global" || (scope as readonly string[]).includes(shown);
        expect(bound, `${command} on ${shown}`).toBe(true);
      }
    }
  });

  test("gives every view a handler for each key bound on it, and no other", () => {
    for (const view of BUILT_IN_VIEWS) {
      const bound = COMMANDS.filter((command) => {
        const { scope }: KeyBinding = KEYMAP[command];
        return scope !== "global" && scope.includes(view);
      });
      expect([...BUILT_IN_SCREENS[view].handles].sort(), view).toEqual(bound.sort());
    }
  });

  test("draws the footers the console has always shown", () => {
    const drawn = Object.fromEntries(
      FOOTERS.map((footer) => [footer, keys(footerKeys(footer, [], undefined))]),
    );
    expect(drawn).toEqual({
      overview: [
        "left/right view",
        "1-9 / tab registry",
        "u pull latest",
        "g reload",
        "? keys",
        "q quit",
      ],
      artifacts: [
        "up/down move",
        "left/right view",
        "1-9 registry",
        "h/l fold",
        "enter detail",
        "p publish",
        "u pull latest",
        "/ filter",
      ],
      jobs: ["up/down move", "R run now", "r retry", "space enable/disable", "g reload"],
      accounts: ["up/down move", "tab next registry", "g reload"],
      settings: ["up/down move", "g reload", "q quit"],
      panel: ["up/down move", "left/right view", "g reload"],
    });
  });

  test("puts a panel's keys after the keymap's, and the upstream link last", () => {
    const declared = [{ key: "a", label: "archive" }];
    expect(keys(footerKeys("panel", declared, "Acme")).slice(-2)).toEqual([
      "a archive",
      "o open in Acme",
    ]);
    expect(keys(helpKeys(declared)).at(-1)).toBe("a archive");
  });

  test("lists the help overlay's keys in its own order, the pointer among them", () => {
    expect(keys(helpKeys([]))).toEqual([
      "left right previous or next view",
      "1 - 9 switch registry",
      "click a tab, or a row",
      "wheel scroll",
      "tab next registry",
      "u pull latest from the registry",
      "p publish a group, or the edited row",
      "up down / j k move",
      "h l fold or unfold a group",
      "enter expand detail, or confirm",
      "R run a job now",
      "r retry a failed run",
      "space enable or disable a job",
      "/ filter",
      "g reload",
      "? q keys, quit",
    ]);
  });
});

describe("globalCommandFor", () => {
  const global = (input: string, pressed?: Pressed, filtering = false) =>
    globalCommandFor(input, key(pressed), { state, filtering });

  test("quits on q and on ctrl-c", () => {
    expect(global("q")).toBe("quit");
    expect(global("c", { ctrl: true })).toBe("quit");
    expect(global("c")).toBeUndefined();
  });

  test("picks only a registry that is there, leaving other digits to the view", () => {
    expect(global("1")).toBe("pick-registry");
    expect(global("2")).toBeUndefined();
  });

  test("keeps only moving and changing view while the filter is open", () => {
    expect(global("j", {}, true)).toBe("move");
    expect(global("", { rightArrow: true }, true)).toBe("view");
    expect(global("q", {}, true)).toBeUndefined();
    expect(global("1", {}, true)).toBeUndefined();
  });
});

describe("viewCommandFor", () => {
  test("answers a key only on the views it is bound on", () => {
    expect(viewCommandFor("artifacts", "", key({ return: true }), state)).toBe("enter");
    expect(viewCommandFor("overview", "", key({ return: true }), state)).toBe("enter");
    expect(viewCommandFor("jobs", "", key({ return: true }), state)).toBeUndefined();
    expect(viewCommandFor("jobs", "R", key(), state)).toBe("run-job");
    expect(viewCommandFor("artifacts", "R", key(), state)).toBeUndefined();
  });
});
