import { describe, expect, it } from "vitest";
import { resolveHarnesses, type Target } from "#core/harness/index.ts";
import { sharedReads } from "./tools.ts";

describe("sharedReads", () => {
  it("names who reads each kind from the shared folder, one tool or several", () => {
    const all = resolveHarnesses({ HOME: "/home/dev" });
    const cursor = all.cursor as Target;
    const harnesses = {
      codex: all.codex as Target,
      cursor: { ...cursor, reads: { ...cursor.reads, agent: ["cursor", "agents"] } },
      agents: all.agents as Target,
    };
    expect(sharedReads(harnesses)).toEqual([
      "Cursor reads agents from the shared .agents folder.",
      "Codex and Cursor read skills from the shared .agents folder.",
    ]);
  });
});
