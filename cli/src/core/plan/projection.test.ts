import { describe, expect, test } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { movedPluginLinks } from "./projection.ts";

describe("movedPluginLinks", () => {
  const USER = roots("user", "/work");
  const scope = { roots: USER, env: process.env, targetTable: resolveTargets(process.env) };
  function lockWith(rows: Record<string, { registry: string; link: string; target?: string }>) {
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
        links: [{ target: row.target ?? "claude-code", path: row.link, mode: "symlink" }],
      };
    }
    return lock;
  }

  test("names the row still at the bare name once another registry shares it", () => {
    const lock = lockWith({
      fmt: { registry: "far", link: ".claude/skills/engineering" },
      lint: { registry: "kit", link: ".claude/skills/kit-engineering" },
    });
    expect([...movedPluginLinks(lock, scope)]).toEqual(["fmt"]);
  });

  test("names the row still qualified once it has the namespace to itself", () => {
    const lock = lockWith({ lint: { registry: "kit", link: ".claude/skills/kit-engineering" } });
    expect([...movedPluginLinks(lock, scope)]).toEqual(["lint"]);
  });

  test("looks only at the registries the run opened", () => {
    const lock = lockWith({
      fmt: { registry: "far", link: ".claude/skills/engineering" },
      lint: { registry: "kit", link: ".claude/skills/engineering" },
    });
    expect([...movedPluginLinks(lock, scope, new Set(["kit"]))]).toEqual(["lint"]);
  });

  test("leaves a target that already keys plugins by registry alone", () => {
    const lock = lockWith({
      fmt: {
        registry: "far",
        link: ".codex/plugins/cache/far/engineering/local",
        target: "codex",
      },
      lint: {
        registry: "kit",
        link: ".codex/plugins/cache/kit/engineering/local",
        target: "codex",
      },
    });
    expect([...movedPluginLinks(lock, scope)]).toEqual([]);
  });
});
