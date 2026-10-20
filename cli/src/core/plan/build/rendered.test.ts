import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type KindMapping, resolveHarnesses, type Target } from "#core/harness/index.ts";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import { roots } from "#core/store/paths.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS, wrapping } from "#test/kit/builders/plan.ts";

const REVIEWER = entry({ name: "reviewer", kind: "agent", path: "agents/reviewer.md" });

describe("an agent for a harness that reads its own format", () => {
  it("is written on its own even where its namespace becomes a Codex plugin", () => {
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, roots: roots("user", "/work"), targets: ["claude", "codex"] },
    );
    const codex = plan.actions.flatMap((action) =>
      action.kind === "link" && action.harness === "codex" ? [relative("/work", action.to)] : [],
    );
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatch(/agents[\\/]reviewer\.toml$/);
  });
});

describe("a harness that places a kind as a folder of its own", () => {
  it("writes an agent into its own folder, never through the plugin its namespace becomes", () => {
    const harnesses = resolveHarnesses();
    const claude = harnesses.claude as Target;
    harnesses.claude = {
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
      { ...PLAN_OPTIONS, harnesses, roots: roots("user", "/work"), targets: ["claude"] },
    );
    const links = plan.actions.filter((action) => action.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ entry: "AGENT.md", plugin: false });
    expect(relative("/work", links[0]?.to as string)).not.toContain("plugins");
  });

  it("copies a plugin folder for a harness that will not load a linked one", () => {
    const harnesses = resolveHarnesses();
    const claude = harnesses.claude as Target;
    const plugin = claude.kinds.plugin as Extract<KindMapping, { shape: "directory" }>;
    harnesses.claude = {
      ...claude,
      kinds: { ...claude.kinds, plugin: { ...plugin, place: "copy" } },
    };
    const plan = build(
      kitManifest(["kit/agent/reviewer"]),
      emptyLock(),
      wrapping(acquired([REVIEWER], "c1", new Map([["agents/reviewer.md", "sha256:a1"]]))),
      { artifacts: {} },
      { ...PLAN_OPTIONS, harnesses, roots: roots("user", "/work"), targets: ["claude"] },
    );
    expect(plan.actions.find((action) => action.kind === "link")).toMatchObject({
      plugin: true,
      copy: true,
    });
  });
});
