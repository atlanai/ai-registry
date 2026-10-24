import { describe, expect, it } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { emptyLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { movedPluginLinks } from "./projection.ts";

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
