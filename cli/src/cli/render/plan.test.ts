import { describe, expect, it } from "vitest";
import type { Lock } from "#core/lock.ts";
import { Printer } from "#core/output.ts";
import type { ApplyResult } from "#core/plan/apply.ts";
import { type Action, emptyPlan } from "#core/plan/model.ts";
import { summarize } from "./plan.ts";

function printed(
  actions: Action[],
  applied: Partial<ApplyResult>,
  before: Record<string, unknown> = {},
): string[] {
  const lines: string[] = [];
  const sink = { write: (chunk: string) => lines.push(chunk.trimEnd()), isTTY: false };
  const printer = new Printer({ out: sink, err: sink, color: "never" });
  const result = {
    performed: {},
    installed: [],
    added: [],
    removed: [],
    kept: [],
    carried: [],
    ...applied,
  } as unknown as ApplyResult;
  summarize(printer, {
    plan: { ...emptyPlan(), actions },
    applied: result,
    before: { artifacts: before, registries: {} } as unknown as Lock,
  });
  return lines;
}

const link = (name: string, harness: string) =>
  ({ kind: "link", name, harness, from: "f", to: `t/${harness}/${name}`, copy: false }) as Action;

describe("summarize", () => {
  it("names what was installed and where, not how many steps ran", () => {
    const actions = [link("lint", "claude"), link("lint", "agents")];
    const applied = { performed: { link: 2 } as never, installed: ["lint"], added: ["lint"] };
    expect(printed(actions, applied)).toEqual(["✓ Installed lint into claude and agents."]);
  });

  it("names every member of a new namespace as installed, though one link carries them", () => {
    const clone = (name: string) => ({ kind: "clone", name, from: "f", to: `c/${name}` }) as Action;
    const row = (harness: string) => ({ links: [{ harness, path: "p", mode: "symlink" }] });
    const lock = { artifacts: { add: row("claude"), new: row("claude"), publish: row("claude") } };
    const actions = [link("add", "claude"), clone("add"), clone("new"), clone("publish")];
    const applied = {
      performed: { link: 1, clone: 3 } as never,
      installed: ["add"],
      added: ["add", "new", "publish"],
      lock: lock as never,
    };
    expect(printed(actions, applied)).toEqual(["✓ Installed add, new and publish into claude."]);
  });

  it("says which harnesses start a plugin's hooks and MCP servers", () => {
    const actions = [link("tools", "claude"), link("tools", "codex")];
    const applied = {
      performed: { link: 2 } as never,
      installed: ["tools"],
      added: ["tools"],
      carried: [{ name: "tools", carries: ["hooks", "mcpServers"] }] as ApplyResult["carried"],
    };
    expect(printed(actions, applied)).toEqual([
      "✓ Installed tools into claude and codex.",
      "  runs   hooks and MCP servers from tools, in claude and codex",
    ]);
  });

  it("calls a new version of an installed artifact an update", () => {
    const actions = [
      { kind: "clone", name: "lint", from: "f", to: "c" } as Action,
      link("lint", "claude"),
    ];
    const applied = { performed: { link: 1, clone: 1 } as never, installed: ["lint"], added: [] };
    expect(printed(actions, applied)).toEqual(["✓ Updated lint."]);
  });

  it("says which version an update moved from and to", () => {
    const actions = [
      { kind: "clone", name: "lint", from: "f", to: "c" } as Action,
      link("lint", "claude"),
    ];
    const lock = { artifacts: { lint: { version: "0.2.0", links: [] } } };
    const applied = { performed: { link: 1, clone: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ harness: "claude" }] } };
    expect(printed(actions, applied, before)).toEqual(["✓ Updated lint 0.1.0 → 0.2.0."]);
  });

  it("calls a link put back at the same version a restore, not an update", () => {
    const lock = { artifacts: { lint: { version: "0.1.0", links: [] } } };
    const applied = { performed: { link: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ harness: "claude" }] } };
    expect(printed([link("lint", "claude")], applied, before)).toEqual([
      "✓ Restored lint in claude.",
    ]);
  });

  it("calls content fetched and copied again at the same version a restore, not an update", () => {
    const actions = [
      { kind: "stage", name: "lint", source: "s", path: "p", to: "m" } as Action,
      { kind: "clone", name: "lint", from: "m", to: "c" } as Action,
    ];
    const lock = { artifacts: { lint: { version: "0.1.0", links: [] } } };
    const applied = { performed: { stage: 1, clone: 1 } as never, lock: lock as never };
    const before = { lint: { version: "0.1.0", links: [{ harness: "claude" }] } };
    expect(printed(actions, applied, before)).toEqual(["✓ Restored lint."]);
  });

  it("names a row of yours whose harness links went as removed, though the row stays", () => {
    const gone = [{ kind: "unlink", name: "lint", to: "x" } as Action];
    const lock = { artifacts: { lint: { links: [] } } };
    const applied = { performed: { unlink: 1 } as never, removed: ["lint"], lock: lock as never };
    expect(printed(gone, applied)).toEqual(["✓ Removed lint."]);
  });

  it("names what was removed, and counts a long list", () => {
    const gone = ["a", "b", "c", "d"].map((name) => ({ kind: "unlink", name, to: "x" }) as Action);
    const applied = { performed: { unlink: 4 } as never, removed: ["a", "b", "c", "d"] };
    expect(printed(gone, applied)).toEqual(["✓ Removed 4 artifacts."]);
  });
});
