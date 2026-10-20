import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";
import { pluginProjection, resolveHarnesses, takesPlugin, trustFor } from "./index.ts";

const BUILTIN = Object.fromEntries(BUILTIN_HARNESSES.map((harness) => [harness.id, harness]));

describe("built-in harnesses", () => {
  it("places or reads something for every harness", () => {
    // An entry with neither could never be installed into.
    for (const [id, harness] of Object.entries(BUILTIN)) {
      const reads = Object.values(harness.reads ?? {}).flat();
      expect(Object.keys(harness.kinds).length + reads.length, id).toBeGreaterThan(0);
    }
  });
});

describe("claude", () => {
  it("asks a person to trust a project before it loads the plugins placed there", () => {
    const claude = resolveHarnesses({ HOME: "/tmp/home" }).claude!;
    expect(trustFor(claude, "plugin", "project")).toBe("claude");
    expect(trustFor(claude, "plugin", "user")).toBeUndefined();
    expect(trustFor(claude, "skill", "project")).toBeUndefined();
  });
});

describe("codex", () => {
  it("links a whole plugin into its cache, keyed by source, not exploded skills", () => {
    const env = { HOME: "/tmp/home", CODEX_HOME: "/tmp/home/.codex" };
    const codex = resolveHarnesses(env).codex!;
    expect(takesPlugin(codex)).toBe(true);
    expect(codex.kinds.plugin?.place).toBe("fan");
    expect(pluginProjection(codex, "sales", "user", "/tmp/proj", env, "acme-prod")).toBe(
      resolve("/tmp/home/.codex/plugins/cache/acme-prod/sales/local"),
    );
    // Plugins are read from the user installation alone.
    expect(takesPlugin(codex, "project")).toBe(false);
  });
});
