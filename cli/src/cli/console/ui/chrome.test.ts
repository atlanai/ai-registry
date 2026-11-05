import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { type Activity, header, tabsWith } from "./chrome.ts";

const ids = (tabs: readonly { id: string }[]) => tabs.map((tab) => tab.id);

describe("tabsWith", () => {
  test("puts a panel after the tab it named", () => {
    const tabs = tabsWith([{ id: "sessions", label: "Sessions", after: "artifacts" }]);
    expect(ids(tabs)).toEqual([
      "overview",
      "artifacts",
      "sessions",
      "jobs",
      "accounts",
      "settings",
    ]);
  });

  test("keeps Settings last when the panel names a tab that is not here", () => {
    const tabs = tabsWith([{ id: "probe", label: "Probe", after: "nowhere" }]);
    expect(ids(tabs).slice(-2)).toEqual(["probe", "settings"]);
  });
});

function draw(element: ReactElement, columns: number): string[] {
  const writes: string[] = [];
  const stdout = {
    columns,
    rows: 40,
    write: (chunk: string) => writes.push(chunk),
    on() {},
    off() {},
  };
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  // Read the frame before unmounting: under CI, Ink writes a bare newline on unmount.
  const frame = writes.at(-1) ?? "";
  instance.unmount();
  return stripVTControlCharacters(frame)
    .split("\n")
    .map((line) => line.trimEnd());
}

const at = (hours: number, minutes: number) => new Date(2026, 9, 8, hours, minutes).getTime();

function top(width: number, overrides: Partial<Parameters<typeof header>[0]> = {}): string {
  const lines = draw(
    header({
      width,
      activity: undefined,
      lastPullAtMs: at(22, 56),
      daemonRunning: true,
      read: "read 23:00",
      ...overrides,
    }),
    width,
  );
  // One line and its rule: a header that wraps pushes every view down.
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(/^─+$/);
  return lines[0] as string;
}

describe("header", () => {
  test("names aireg, then the pull and the daemon", () => {
    const line = top(100);
    expect(line).toMatch(/^◆ aireg console +pulled 22:56 · u pull {3}● daemon · read 23:00$/);
    expect(line).toHaveLength(100);
  });

  test("says when nothing has been pulled yet", () => {
    expect(top(100, { lastPullAtMs: undefined })).toContain("not pulled yet · u pull");
  });

  test("drops the daemon first, then the pull, and never wraps", () => {
    const activity: Activity = {
      label: "pull latest",
      line: "examined 120 of 340 artifacts across every namespace",
      done: false,
      failed: false,
    };
    const narrower = top(80, { activity });
    expect(narrower).not.toContain("daemon");
    expect(narrower).toMatch(/esc cancel {3}read 23:00$/);
    expect(top(40)).toMatch(/^◆ aireg console +read 23:00$/);
  });

  test("shows a running command in place of the pull hint", () => {
    const activity: Activity = {
      label: "pull latest",
      line: "2 examined",
      done: false,
      failed: false,
    };
    const line = top(120, { activity });
    expect(line).toContain("⟳ pull latest 2 examined  esc cancel");
    expect(line).not.toContain("u pull");
    expect(line).toMatch(/read 23:00$/);
  });
});
