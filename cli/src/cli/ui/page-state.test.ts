import { describe, expect, test } from "vitest";
import type { ArtifactRow } from "#core/console/model.ts";
import type { Catalog } from "./catalogs.ts";
import { joined, THIS_MACHINE } from "./page-state.ts";

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return {
    key: "engineering/pr-review",
    name: "pr-review",
    kind: "skill",
    registry: "acme",
    namespace: "engineering",
    id: "",
    version: "1.2.0",
    lockDigest: "sha256:1",
    diskDigest: "sha256:1",
    state: "ok",
    detail: undefined,
    targets: ["Claude Code"],
    copy: "/home/dev/.registry/artifacts/acme/engineering/skills/pr-review",
    changedAtMs: undefined,
    links: [],
    ...over,
  };
}

function catalog(name: string, entries: Catalog["entries"]): Catalog {
  return { name, address: `/registries/${name}`, entries, error: undefined, loading: false };
}

const states = (list: ReturnType<typeof joined>) => list.map((a) => [a.registry, a.name, a.state]);

describe("the page's list", () => {
  test("shows everything a registry lists, marked installed or available", () => {
    const list = joined(
      [
        catalog("acme", [
          { name: "pr-review", kind: "skill", namespace: "engineering", path: "a" },
          { name: "reviewer", kind: "agent", namespace: "engineering", path: "b" },
        ]),
      ],
      [{ row: row({}), local: false }],
    );
    expect(states(list)).toEqual([
      ["acme", "pr-review", "ok"],
      ["acme", "reviewer", "available"],
    ]);
    expect(list[0]).toMatchObject({
      key: "acme/engineering/skill/pr-review",
      listed: true,
      installedKey: "engineering/pr-review",
    });
  });

  test("joins a marketplace plugin to its install, and a skill it carries to the plugin", () => {
    const plugin = row({
      key: "deploy-kit",
      name: "deploy-kit",
      kind: "plugin",
      registry: "tools",
      namespace: "tools",
    });
    const list = joined(
      [
        catalog("tools", [
          { name: "deploy-kit", kind: "plugin", path: "p" },
          { name: "ship", kind: "skill", namespace: "deploy-kit", path: "s" },
        ]),
      ],
      [{ row: plugin, local: false }],
    );
    expect(states(list)).toEqual([
      ["tools", "deploy-kit", "ok"],
      ["tools", "ship", "ok"],
    ]);
    expect(list[1]?.detail).toBe("Installed with the plugin deploy-kit, and removed with it.");
  });

  test("never says a folder written here was published just because a registry lists its name", () => {
    const folder = row({
      key: "notes",
      name: "notes",
      registry: "local",
      namespace: undefined,
      state: "unpublished",
      copy: "/home/dev/.claude/skills/notes",
    });
    const list = joined(
      [catalog("mine", [{ name: "notes", kind: "skill", namespace: "personal", path: "n" }])],
      [{ row: folder, local: true }],
    );
    expect(states(list)).toEqual([
      ["mine", "notes", "available"],
      [THIS_MACHINE, "notes", "unpublished"],
    ]);
    expect(list[0]?.detail).toContain("A folder with this name was written on this machine");
    // Work written here is never removed with `aireg remove`: it has no lockfile key.
    expect(list.every((a) => a.installedKey === undefined)).toBe(true);
  });

  test("gives a skill a plugin carries no key of its own, so retiring it cannot remove the plugin", () => {
    const plugin = row({
      key: "deploy-kit",
      name: "deploy-kit",
      kind: "plugin",
      registry: "tools",
      namespace: "tools",
    });
    const list = joined(
      [
        catalog("tools", [
          { name: "deploy-kit", kind: "plugin", path: "p" },
          { name: "ship", kind: "skill", namespace: "deploy-kit", path: "s" },
        ]),
      ],
      [{ row: plugin, local: false }],
    );
    expect(list.find((a) => a.name === "ship")).toMatchObject({
      installedKey: undefined,
      carriedBy: "deploy-kit",
    });
    expect(list.find((a) => a.name === "deploy-kit")).toMatchObject({
      installedKey: "deploy-kit",
      carriedBy: undefined,
    });
  });

  test("keys a row without its state, so it keeps its key while its state changes", () => {
    const before = joined(
      [],
      [{ row: row({ key: "x", name: "x", registry: "r", state: "ok" }), local: false }],
    );
    const after = joined(
      [],
      [{ row: row({ key: "x", name: "x", registry: "r", state: "edited" }), local: false }],
    );
    expect(before[0]?.key).toBe(after[0]?.key);
  });
});
