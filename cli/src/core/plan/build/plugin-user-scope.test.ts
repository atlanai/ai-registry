import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { type BuildOptions, build } from "#core/plan/build.ts";
import type { Action } from "#core/plan/model.ts";
import { artifactPath, projectionDir, roots, stagingPath } from "#core/store/paths.ts";
import {
  acquired,
  kitManifest,
  linksTo,
  PLAN_OPTIONS,
  PLUGIN_TREES,
  pluginCatalog,
} from "#test/kit/builders/plan.ts";

// Claude and Codex read plugins from the user installation, so that is the
// scope these assertions have to be made in; a project gets the parts instead.
describe("a plugin, projected at user scope", () => {
  const USER = roots("user", "/work");
  // The user roots come off the real home, so the expected paths are derived
  // rather than written down: the point is the shape, not this machine.
  const home = homedir();
  const options = (targets: string[]): BuildOptions => ({ ...PLAN_OPTIONS, roots: USER, targets });
  const run = (targets: string[]) =>
    build(
      kitManifest(["kit/toolkit"]),
      emptyLock(),
      acquired(pluginCatalog(), "c1", PLUGIN_TREES),
      { artifacts: {} },
      options(targets),
    );

  it("goes into Claude Code whole, as one link in the directory Claude scans", () => {
    // Not `plugins/`: that is Claude's managed registry, and a directory left
    // there is never read.
    expect(linksTo(run(["claude-code"]).actions, "claude-code")).toEqual([
      join(home, ".claude", "skills", "toolkit"),
    ]);
  });

  it("goes into Codex as one fanned-out cache directory", () => {
    const plan = run(["codex"]);
    expect(linksTo(plan.actions, "codex")).toEqual([
      join(home, ".codex", "plugins", "cache", "kit", "toolkit", "local"),
    ]);
    const link = plan.actions.find((action) => action.kind === "link" && action.target === "codex");
    expect(link?.kind === "link" ? link.fan : undefined).toBe(true);
  });

  it("copies the plugin once and points Codex at that copy", () => {
    const plan = run(["codex"]);
    const staged = stagingPath("tp");
    const copy = artifactPath(USER, "kit", undefined, "plugin", "toolkit", "plugins/toolkit");
    expect(
      plan.actions
        .filter((action): action is Extract<Action, { kind: "clone" }> => action.kind === "clone")
        .map((action) => [action.from, action.to]),
    ).toEqual([[staged, copy]]);
    // The target is pointed at the projection, which links back to `copy`:
    // the content tree carries no manifests, so it is never linked directly.
    const froms = plan.actions
      .filter((action): action is Extract<Action, { kind: "link" }> => action.kind === "link")
      .map((action) => action.from);
    expect(froms).toEqual([projectionDir(USER, "kit", "toolkit")]);
    expect(plan.actions.filter((action) => action.kind === "stage")).toHaveLength(1);
  });

  it("reaches the universal layout as parts, because it has no plugin directory", () => {
    const links = linksTo(run(["universal"]).actions, "universal");
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((path) => !path.includes(".projections"))).toBe(true);
  });

  it("gives Claude and Codex each one plugin link from one address", () => {
    const plan = run(["claude-code", "codex"]);
    expect(linksTo(plan.actions, "claude-code")).toHaveLength(1);
    expect(linksTo(plan.actions, "codex")).toHaveLength(1);
  });
});
