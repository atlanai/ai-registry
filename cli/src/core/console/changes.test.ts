import { describe, expect, test } from "vitest";
import { changesSince, snapshot } from "./changes.ts";
import type { ConsoleState } from "./model.ts";

/** Only what a comparison reads: each group's key and its rows' keys and states. */
function state(groups: Record<string, Record<string, string>>): ConsoleState {
  return {
    groups: Object.entries(groups).map(([key, rows]) => ({
      key,
      rows: Object.entries(rows).map(([row, value]) => ({ key: row, state: value })),
    })),
  } as unknown as ConsoleState;
}

describe("changesSince", () => {
  test("names a state that moved, and nothing that did not", () => {
    const before = snapshot(state({ eng: { lint: "edited", deploy: "ok" } }));
    expect(changesSince(before, state({ eng: { lint: "pending", deploy: "ok" } }))).toEqual([
      "lint: edited → pending",
    ]);
  });

  test("says nothing moved as an empty list", () => {
    const read = state({ eng: { lint: "ok" } });
    expect(changesSince(snapshot(read), read)).toEqual([]);
  });

  test("reads an artifact that changed group as one move, not a loss and an arrival", () => {
    const before = snapshot(state({ local: { audit: "unpublished" } }));
    expect(changesSince(before, state({ eng: { audit: "ok" } }))).toEqual([
      "audit: unpublished in local → ok in eng",
    ]);
  });

  test("names what arrived and what is gone", () => {
    const before = snapshot(state({ eng: { lint: "ok" } }));
    expect(changesSince(before, state({ eng: { deploy: "ok" } }))).toEqual([
      "deploy is now here, ok",
      "lint is gone",
    ]);
  });
});
