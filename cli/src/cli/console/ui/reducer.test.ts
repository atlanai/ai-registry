import { describe, expect, test, vi } from "vitest";
import type { ArtifactRow } from "#core/console/model.ts";
import { type Activity, INITIAL_UI, reduceUi, type UiAction, type UiState } from "./reducer.ts";

const reduce = (actions: UiAction[], from: UiState = INITIAL_UI): UiState =>
  actions.reduce(reduceUi, from);

function activity(): Activity {
  return {
    label: "pull latest",
    startedAtMs: 0,
    command: { argv: ["sync"], display: "aireg sync" },
    lines: [],
    done: false,
    code: undefined,
    changed: undefined,
    cancel: vi.fn(),
  };
}

describe("reduceUi", () => {
  test("starts on Overview with nothing open", () => {
    expect(INITIAL_UI.view).toBe("overview");
    expect(INITIAL_UI.overlay).toEqual({ kind: "none" });
    expect(INITIAL_UI.activity).toBeUndefined();
  });

  test("keeps a cursor per view", () => {
    const ui = reduce([
      { type: "set-cursor", view: "jobs", index: 3 },
      { type: "show-view", view: "artifacts" },
      { type: "set-cursor", view: "artifacts", index: 1 },
    ]);
    expect(ui.view).toBe("artifacts");
    expect(ui.cursors).toEqual({ jobs: 3, artifacts: 1 });
  });

  test("opens a namespace in Artifacts, filtered to it, at the top", () => {
    const ui = reduce([
      { type: "set-cursor", view: "artifacts", index: 7 },
      { type: "open-namespace", filter: "eng" },
    ]);
    expect(ui.view).toBe("artifacts");
    expect(ui.filter).toBe("eng");
    expect(ui.cursors.artifacts).toBe(0);
  });

  test("folds and unfolds a group without touching the set it was given", () => {
    const folded = reduce([{ type: "fold", group: "eng", folded: true }]);
    expect([...folded.folded]).toEqual(["eng"]);
    expect(INITIAL_UI.folded.size).toBe(0);
    const unfolded = reduceUi(folded, { type: "fold", group: "eng", folded: false });
    expect(unfolded.folded.size).toBe(0);
    expect(folded.folded.has("eng")).toBe(true);
  });

  test("types, erases, closes and clears the filter", () => {
    const typed = reduce([
      { type: "open-filter" },
      { type: "type-filter", text: "l" },
      { type: "type-filter", text: "ix" },
      { type: "erase-filter" },
    ]);
    expect(typed).toMatchObject({ filtering: true, filter: "li" });
    expect(reduceUi(typed, { type: "close-filter" })).toMatchObject({
      filtering: false,
      filter: "li",
    });
    expect(reduceUi(typed, { type: "clear-filter" })).toMatchObject({
      filtering: false,
      filter: "",
    });
  });

  test("keeps each panel's flags apart", () => {
    const ui = reduce([
      { type: "set-flag", panel: "sessions", name: "all", value: true },
      { type: "set-flag", panel: "sessions", name: "mine", value: false },
      { type: "set-flag", panel: "probe", name: "all", value: false },
    ]);
    expect(ui.flags).toEqual({ sessions: { all: true, mine: false }, probe: { all: false } });
  });

  test("opens and closes an overlay", () => {
    const row = { key: "eng/lint", name: "lint" } as ArtifactRow;
    const detail = reduce([{ type: "show-overlay", overlay: { kind: "detail", row } }]);
    expect(detail.overlay).toEqual({ kind: "detail", row });
    expect(reduceUi(detail, { type: "show-overlay", overlay: { kind: "none" } }).overlay).toEqual({
      kind: "none",
    });
  });

  test("follows an activity from start to close", () => {
    const started = reduce([
      { type: "start-activity", activity: activity() },
      { type: "print-activity", line: "examined 1" },
      { type: "print-activity", line: "examined 2" },
      { type: "finish-activity", code: 0 },
      { type: "compare-activity", changed: ["lint: edited → ok"] },
    ]);
    expect(started.activity).toMatchObject({
      lines: ["examined 1", "examined 2"],
      done: true,
      code: 0,
      changed: ["lint: edited → ok"],
    });
    expect(reduceUi(started, { type: "close-activity" }).activity).toBeUndefined();
  });

  test("keeps only the lines the activity panel can show", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index): UiAction => ({
        type: "print-activity",
        line: `line ${index}`,
      }),
    );
    const ui = reduce([{ type: "start-activity", activity: activity() }, ...lines]);
    expect(ui.activity?.lines).toHaveLength(16);
    expect(ui.activity?.lines.at(-1)).toBe("line 39");
  });

  test("leaves a closed activity closed", () => {
    const closed = reduce([
      { type: "start-activity", activity: activity() },
      { type: "finish-activity", code: 0 },
      { type: "close-activity" },
    ]);
    for (const late of [
      { type: "print-activity", line: "late" },
      { type: "finish-activity", code: 1 },
      { type: "compare-activity", changed: [] },
    ] satisfies UiAction[]) {
      expect(reduceUi(closed, late)).toBe(closed);
    }
  });
});
