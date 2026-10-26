import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { pluginProjection, resolveTargets, takesPlugin, trustFor } from "./index.ts";

const BUILTIN = Object.fromEntries(BUILTIN_TARGETS.map((target) => [target.id, target]));

describe("built-in targets", () => {
  it("places or reads something for every target", () => {
    // An entry with neither could never be installed into.
    for (const [id, target] of Object.entries(BUILTIN)) {
      const reads = Object.values(target.reads ?? {}).flat();
      expect(Object.keys(target.kinds).length + reads.length, id).toBeGreaterThan(0);
    }
  });
});

describe("claude-code", () => {
  it("asks a person to trust a project before it loads the plugins placed there", () => {
    const claude = resolveTargets({ HOME: "/tmp/home" })["claude-code"]!;
    expect(trustFor(claude, "plugin", "project")).toBe("claude");
    expect(trustFor(claude, "plugin", "user")).toBeUndefined();
    expect(trustFor(claude, "skill", "project")).toBeUndefined();
  });
});

describe("codex", () => {
  it("links a whole plugin into its cache, keyed by source, not exploded skills", () => {
    const env = { HOME: "/tmp/home", CODEX_HOME: "/tmp/home/.codex" };
    const codex = resolveTargets(env).codex!;
    expect(takesPlugin(codex)).toBe(true);
    expect(codex.kinds.plugin?.place).toBe("fan");
    expect(pluginProjection(codex, "sales", "user", "/tmp/proj", env, "acme-prod")).toBe(
      resolve("/tmp/home/.codex/plugins/cache/acme-prod/sales/local"),
    );
    // Plugins are read from the user installation alone.
    expect(takesPlugin(codex, "project")).toBe(false);
  });

  it("asks a person to trust a project before it loads the agents placed there", () => {
    const codex = resolveTargets({ HOME: "/tmp/home" }).codex!;
    expect(trustFor(codex, "agent", "project")).toBe("codex");
    expect(trustFor(codex, "agent", "user")).toBeUndefined();
    expect(trustFor(codex, "skill", "project")).toBeUndefined();
  });
});
