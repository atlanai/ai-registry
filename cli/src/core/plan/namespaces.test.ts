import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { advertisedCapabilities } from "#adapter/contract.ts";
import type { LockArtifact } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { wrappedInLock, wrapsNamespaces } from "./namespaces.ts";

describe("wrapsNamespaces", () => {
  const adapter = (declared: { namespacePlugins?: boolean } = {}) => ({
    capabilities: advertisedCapabilities(declared),
  });

  it("is off unless the source declares it", () => {
    expect(wrapsNamespaces(adapter())).toBe(false);
    expect(wrapsNamespaces(adapter({ namespacePlugins: false }))).toBe(false);
  });

  it("is on for a source that declares namespacePlugins", () => {
    expect(wrapsNamespaces(adapter({ namespacePlugins: true }))).toBe(true);
  });
});

describe("wrappedInLock", () => {
  const user = roots("user", "/work");
  const options = { roots: user, harnesses: PLAN_OPTIONS.harnesses };
  const row = (path: string): readonly [string, LockArtifact] => [
    "engineering/lint",
    {
      registry: "kit",
      kind: "skill",
      namespace: "engineering",
      links: [{ harness: "claude", path: relative(user.base, path), mode: "symlink" }],
    } as unknown as LockArtifact,
  ];

  it("reads a row linked through its namespace's plugin directory as wrapped", () => {
    const plugin = join(homedir(), ".claude", "skills", "engineering");
    expect(wrappedInLock([row(plugin)], options)).toBe(true);
  });

  it("reads a row linked as itself as not wrapped", () => {
    const flat = join(homedir(), ".claude", "skills", "lint");
    expect(wrappedInLock([row(flat)], options)).toBe(false);
  });
});
