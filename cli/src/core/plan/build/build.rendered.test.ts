import { relative } from "node:path";
import { describe, expect, test } from "vitest";
import { emptyLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import type { KindMapping, Target } from "#core/target/contract.ts";
import { resolveTargets } from "#core/target/table.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS, wrapping } from "#test/kit/builders/plan.ts";
import { build } from "./build.ts";

const REVIEWER = entry({ name: "reviewer", kind: "agent", path: "agents/reviewer.md" });

describe("an agent for a target that reads its own format", () => {
  test("is written on its own even where its namespace becomes a Codex plugin", () => {
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, roots: roots("user", "/work"), targets: ["claude-code", "codex"] },
    );
    const codex = plan.actions.flatMap((action) =>
      action.kind === "link" && action.target === "codex" ? [relative("/work", action.to)] : [],
    );
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatch(/agents[\\/]reviewer\.toml$/);
  });
});

describe("a target that places a kind as a folder of its own", () => {
  test("writes an agent into its own folder, never through the plugin its namespace becomes", () => {
    const targetTable = resolveTargets(process.env);
    const claude = targetTable["claude-code"] as Target;
    targetTable["claude-code"] = {
      ...claude,
      kinds: {
        ...claude.kinds,
        agent: { shape: "directory", subdir: "agents", entry: "AGENT.md" },
      },
    };
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, targetTable, roots: roots("user", "/work"), targets: ["claude-code"] },
    );
    const links = plan.actions.filter((action) => action.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ entry: "AGENT.md", plugin: false });
    expect(relative("/work", links[0]?.to as string)).not.toContain("plugins");
  });

  test("copies a plugin folder for a target that will not load a linked one", () => {
    const targetTable = resolveTargets(process.env);
    const claude = targetTable["claude-code"] as Target;
    const plugin = claude.kinds.plugin as Extract<KindMapping, { shape: "directory" }>;
    targetTable["claude-code"] = {
      ...claude,
      kinds: { ...claude.kinds, plugin: { ...plugin, place: "copy" } },
    };
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, targetTable, roots: roots("user", "/work"), targets: ["claude-code"] },
    );
    expect(plan.actions.find((action) => action.kind === "link")).toMatchObject({
      plugin: true,
      copy: true,
    });
  });
});
