import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";

const test = base.extend("kit", async ({ tmp }) =>
  registry(join(tmp, "kit"))
    .skill("kit/lint@1.0.0", { description: "Lint it." })
    .agent("kit/reviewer@1.0.0", { description: "Reviews." })
    .write(),
);

describe("the tools a result names", () => {
  // Cursor reads both from folders Claude Code and Codex get, so nothing is written for it.
  test("include one an entry's own targets add, though it needed no folder", async ({
    aireg,
    kit,
  }) => {
    const added = await aireg(["add", kit, "--all", "--for", "claude,codex,cursor", "--yes"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("for Claude Code, Codex and Cursor.");
  });
});
