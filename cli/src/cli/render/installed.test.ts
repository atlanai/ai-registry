import { describe, expect, test } from "vitest";
import type { LockArtifact } from "#core/lock.ts";
import { resolveTargets } from "#core/target/table.ts";
import { watchedFrom } from "./installed.ts";

describe("watchedFrom", () => {
  test("names the target under its aireg 0.1 key and id too", () => {
    const entry = {
      origin: { target: "claude-code", path: ".claude/skills/lint", step: "" },
    } as unknown as LockArtifact;
    expect(watchedFrom(entry, resolveTargets(process.env))).toEqual({
      target: "claude-code",
      harness: "claude",
      path: ".claude/skills/lint",
    });
    expect(watchedFrom(undefined, resolveTargets(process.env))).toBeUndefined();
  });
});
