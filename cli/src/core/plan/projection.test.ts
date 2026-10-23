import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { emptyLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { claim, crowdedContainers, movedPluginLinks, type PlannedLink } from "./projection.ts";

describe("movedPluginLinks", () => {
  const USER = roots("user", "/work");
  const scope = { roots: USER, harnesses: resolveHarnesses() };
  function lockWith(rows: Record<string, { registry: string; link: string; harness?: string }>) {
    const lock = emptyLock();
    for (const [name, row] of Object.entries(rows)) {
      lock.artifacts[name] = {
        registry: row.registry,
        id: name,
        name,
        kind: "skill",
        namespace: "engineering",
        address: name,
        path: `.registry/artifacts/${row.registry}/engineering/skills/${name}`,
        origin: undefined,
        content: undefined,
        version: undefined,
        digest: "",
        links: [{ harness: row.harness ?? "claude", path: row.link, mode: "symlink" }],
      };
    }
    return lock;
  }

  it("names the row still at the bare name once another registry shares it", () => {
    const lock = lockWith({
      fmt: { registry: "far", link: ".claude/skills/engineering" },
      lint: { registry: "kit", link: ".claude/skills/kit-engineering" },
    });
    expect([...movedPluginLinks(lock, scope)]).toEqual(["fmt"]);
  });

  it("names the row still qualified once it has the namespace to itself", () => {
    const lock = lockWith({ lint: { registry: "kit", link: ".claude/skills/kit-engineering" } });
    expect([...movedPluginLinks(lock, scope)]).toEqual(["lint"]);
  });

  it("looks only at the registries the run opened", () => {
    const lock = lockWith({
      fmt: { registry: "far", link: ".claude/skills/engineering" },
      lint: { registry: "kit", link: ".claude/skills/engineering" },
    });
    expect([...movedPluginLinks(lock, scope, new Set(["kit"]))]).toEqual(["lint"]);
  });

  it("leaves a harness that already keys plugins by registry alone", () => {
    const lock = lockWith({
      fmt: {
        registry: "far",
        link: ".codex/plugins/cache/far/engineering/local",
        harness: "codex",
      },
      lint: {
        registry: "kit",
        link: ".codex/plugins/cache/kit/engineering/local",
        harness: "codex",
      },
    });
    expect([...movedPluginLinks(lock, scope)]).toEqual([]);
  });
});

describe("crowdedContainers", () => {
  const scope = { roots: roots("user", "/work"), harnesses: resolveHarnesses() };
  const skills = (name: string) => join(homedir(), ".claude", "skills", name);
  const wants = (pairs: [string, string][]) =>
    pairs.map(([source, namespace]) => ({ harness: "claude", source, namespace }));

  it("crowds a bare name another registry's qualified name lands on", () => {
    const crowded = crowdedContainers(
      wants([
        ["q", "c"],
        ["x", "c"],
        ["z", "q-c"],
      ]),
      scope,
    );
    // `q`'s `c` qualifies to `q-c`, so `z`'s `q-c` qualifies too, to `z-q-c`.
    expect([...crowded].sort()).toEqual([skills("c"), skills("q-c")]);
  });

  it("does not crowd a name only one registry's namespace wants", () => {
    const crowded = crowdedContainers(
      wants([
        ["kit", "engineering"],
        ["kit", "engineering"],
        ["far", "ops"],
      ]),
      scope,
    );
    expect([...crowded]).toEqual([]);
  });
});

describe("claim", () => {
  const container = (content: string): PlannedLink => ({
    harness: "claude",
    absolute: "/home/.claude/skills/a-b-c",
    relative: ".claude/skills/a-b-c",
    from: "/projections/a-b-c",
    shared: true,
    content,
  });

  it("shares a plugin directory within its namespace, and with no other", () => {
    const claimed = new Map<string, string>();
    const plugins = new Map<string, string>();
    const collisions: string[] = [];
    const collided = (owner: string) => collisions.push(owner);
    const plugin = container("/content/a-b/c");

    expect(claim([plugin], "one", claimed, plugins, collided)).toEqual([plugin]);
    expect(claim([plugin], "two", claimed, plugins, collided)).toEqual([plugin]);
    expect(claim([container("/content/a/b-c")], "three", claimed, plugins, collided)).toEqual([]);
    expect(collisions).toEqual(["two"]);
  });

  it("does not take a path a link of another artifact holds", () => {
    const claimed = new Map([["/home/.claude/skills/a-b-c", "flat"]]);
    const collisions: string[] = [];
    const kept = claim([container("/content/a-b/c")], "one", claimed, new Map(), (owner) =>
      collisions.push(owner),
    );
    expect(kept).toEqual([]);
    expect(collisions).toEqual(["flat"]);
  });
});
