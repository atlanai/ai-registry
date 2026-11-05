import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import type { LockArtifact } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { wrappedInLock } from "./namespaces.ts";

describe("wrappedInLock", () => {
  const user = roots("user", "/work");
  const options = { roots: user, env: process.env, targetTable: PLAN_OPTIONS.targetTable };
  const row = (path: string): readonly [string, LockArtifact] => [
    "engineering/lint",
    {
      registry: "kit",
      kind: "skill",
      namespace: "engineering",
      links: [{ target: "claude-code", path: relative(user.base, path), mode: "symlink" }],
    } as unknown as LockArtifact,
  ];

  test("reads a row linked through its namespace's plugin directory as wrapped", () => {
    const plugin = join(homedir(), ".claude", "skills", "engineering");
    expect(wrappedInLock([row(plugin)], options)).toBe(true);
  });

  test("reads a row linked as itself as not wrapped", () => {
    const flat = join(homedir(), ".claude", "skills", "lint");
    expect(wrappedInLock([row(flat)], options)).toBe(false);
  });
});
