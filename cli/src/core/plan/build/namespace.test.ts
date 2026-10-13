import { describe, expect, it } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import type { Action } from "#core/plan/model.ts";
import { artifactPath, projectionDir, roots, stagingPath } from "#core/store/paths.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS, wrapping } from "#test/kit/builders/plan.ts";

const OPTIONS = { ...PLAN_OPTIONS, targets: ["claude", "codex"] };
const ENTRIES = [
  entry({ name: "lint", path: "plugins/engineering/skills/lint", group: "engineering" }),
  entry({ name: "lint", path: "plugins/sales/skills/lint", group: "sales" }),
];
const CONTENTS = new Map(ENTRIES.map((each) => [each.path, "sha256:lint"]));

function planned(entries = ENTRIES, options = OPTIONS, wraps = false) {
  const sources = acquired(entries, "c1", CONTENTS);
  return build(
    kitManifest(["kit"]),
    emptyLock(),
    wraps ? wrapping(sources) : sources,
    { artifacts: {} },
    options,
  );
}

const linksOf = (actions: readonly Action[]) =>
  actions.filter((action): action is Extract<Action, { kind: "link" }> => action.kind === "link");

describe("a namespaced skill, projected", () => {
  it("stages each skill and clones it under its own namespace", () => {
    const plan = planned();
    const staged = plan.actions.filter((action) => action.kind === "stage");
    expect(staged.map((action) => action.name).sort()).toEqual(["engineering/lint", "sales/lint"]);
    // Staged by what the bytes are: the cache is shared by every registry and checked on reuse.
    expect(staged.map((action) => action.to)).toEqual([
      stagingPath("sha256:lint"),
      stagingPath("sha256:lint"),
    ]);

    const clones = plan.actions.filter(
      (action): action is Extract<Action, { kind: "clone" }> => action.kind === "clone",
    );
    expect(clones.map((action) => action.to).sort()).toEqual(
      [
        artifactPath(OPTIONS.roots, "kit", "engineering", "skill", "lint", ""),
        artifactPath(OPTIONS.roots, "kit", "sales", "skill", "lint", ""),
      ].sort(),
    );
    // Content only: no `plugins/` wrapper, the namespace is the directory.
    expect(clones.some((action) => action.to.includes("/plugins/"))).toBe(false);
  });

  // At user scope, where Claude and Codex read plugins from.
  it("points Claude and Codex at the namespace's plugin directory, when its source says so", () => {
    const at = { ...OPTIONS, roots: roots("user", "/work") };
    const links = linksOf(planned(ENTRIES, at, true).actions);
    const froms = links
      .filter((link) => link.harness === "claude")
      .map((link) => link.from)
      .sort();
    expect(froms).toEqual(
      [
        projectionDir(at.roots, "kit", "engineering"),
        projectionDir(at.roots, "kit", "sales"),
      ].sort(),
    );
    expect(links.some((link) => link.to.includes(".claude-plugin"))).toBe(false);

    const codex = links.filter((link) => link.harness === "codex");
    expect(codex.map((link) => link.from).sort()).toEqual(froms);
    expect(codex.map((link) => link.to.split("/").at(-2)).sort()).toEqual(["engineering", "sales"]);
    expect(codex.every((link) => link.to.endsWith("/local") && link.fan === true)).toBe(true);
    // Codex has the namespace as a plugin, so it needs no flat copy as well.
    expect(links.some((link) => link.harness === "agents")).toBe(false);
  });

  // A namespace is where a skill comes from, not a plugin, unless its source declares it one.
  it("places a skill as itself at user scope, where Claude and Codex read it", () => {
    const at = { ...OPTIONS, roots: roots("user", "/work") };
    const links = linksOf(planned(ENTRIES.slice(0, 1), at).actions);
    expect(links.map((link) => [link.harness, link.to.split("/").slice(-3).join("/")])).toEqual([
      ["agents", ".agents/skills/lint"],
      ["claude", ".claude/skills/lint"],
    ]);
    expect(links.every((link) => link.plugin === false && link.fan === undefined)).toBe(true);
    expect(links.some((link) => link.from.includes(".projections"))).toBe(false);
  });

  it("refuses two namespaces' skills of one name at user scope, as in a project", () => {
    const at = { ...OPTIONS, roots: roots("user", "/work") };
    const plan = planned(ENTRIES, at);
    // The first keeps the folders; the second is reported rather than overwriting it.
    expect(linksOf(plan.actions).map((link) => link.name)).toEqual([
      "engineering/lint",
      "engineering/lint",
    ]);
    expect(plan.clashes.map((clash) => clash.name)).toEqual(["sales/lint"]);
  });

  it("keeps a project's Codex skills flat, where Codex reads them", () => {
    const links = linksOf(planned(ENTRIES.slice(0, 1)).actions);
    const flat = links.filter((link) => link.harness === "agents");
    expect(flat.map((link) => link.to)).toEqual(["/work/.agents/skills/lint"]);
    expect(links.some((link) => link.fan === true)).toBe(false);
  });

  it("gives Cursor a folder it reads when Claude's holds plugins", () => {
    const at = { ...OPTIONS, roots: roots("user", "/work"), targets: ["claude", "cursor"] };
    const flat = linksOf(planned(ENTRIES.slice(0, 1), at, true).actions).filter(
      (link) => link.harness !== "claude",
    );
    expect(flat.map((link) => [link.harness, link.to.endsWith("/.agents/skills/lint")])).toEqual([
      ["agents", true],
    ]);
  });

  it("lets Cursor read Claude's folder when it holds the skill as itself", () => {
    const at = { ...OPTIONS, roots: roots("user", "/work"), targets: ["claude", "cursor"] };
    const links = linksOf(planned(ENTRIES.slice(0, 1), at).actions);
    expect(links.map((link) => link.harness)).toEqual(["claude"]);
  });
});
