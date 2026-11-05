import { describe, expect, test } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { acquired, entry, kitManifest } from "#test/kit/builders/plan.ts";
import { select } from "./select.ts";

const lock = emptyLock();

describe("select", () => {
  test("returns what it chose and nothing else when every entry matches", () => {
    const selection = select({ manifest: kitManifest(), lock, acquired: acquired([entry()]) });
    expect(selection.selected.map((item) => item.name)).toEqual(["lint"]);
    expect(selection).toMatchObject({ warnings: [], incompatible: [], clashes: [], untrusted: [] });
  });

  test("returns a warning for an entry that matches nothing", () => {
    const selection = select({
      manifest: kitManifest(["kit/skill/ghost"]),
      lock,
      acquired: acquired([entry()]),
    });
    expect(selection.selected).toEqual([]);
    expect(selection.warnings.map((warning) => warning.message)).toEqual([
      "kit/skill/ghost matches nothing this registry publishes.",
    ]);
  });

  test("returns an artifact too new for this CLI as incompatible", () => {
    const selection = select({
      manifest: kitManifest(),
      lock,
      acquired: acquired([entry({ engine: ">=99.0.0" })]),
      cliVersion: "1.0.0",
    });
    expect(selection.selected).toEqual([]);
    expect(selection.incompatible).toEqual([{ name: "lint", engine: ">=99.0.0" }]);
    expect(selection.warnings).toHaveLength(1);
  });

  test("returns a clash when two entries take one installed name", () => {
    const selection = select({
      manifest: kitManifest(["kit/skill/lint", "kit/agent/lint"]),
      lock,
      acquired: acquired([entry(), entry({ kind: "agent", path: "agents/lint.md" })]),
    });
    expect(selection.selected.map((item) => item.path)).toEqual(["skills/lint"]);
    expect(selection.clashes).toEqual([
      { name: "lint", kept: "kit/skill/lint", dropped: "kit/agent/lint" },
    ]);
  });

  test("takes the installed name a rename gives", () => {
    const selection = select({
      manifest: kitManifest(),
      lock,
      acquired: acquired([entry()]),
      renames: new Map([["kit/skill/lint", "kit-lint"]]),
    });
    expect(selection.selected.map((item) => item.name)).toEqual(["kit-lint"]);
  });
});
