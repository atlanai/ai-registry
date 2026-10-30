import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";

const test = base.extend("kit", async ({ tmp }) =>
  registry(join(tmp, "kit")).skill("kit/lint@1.0.0", { description: "Lint it." }).write(),
);

const GROK_TRUST = "Grok Build loads skills here only once you trust them: run `grok --trust`.";
const GROK_RELOAD = "Start a new Grok Build session to load the change.";
const CURSOR_RELOAD = "Restart Cursor, or run Developer: Reload Window, to load the change.";

describe("a skill in the folder several tools read", () => {
  test("says what each tool that reads it asks, on install and on removal", async ({
    aireg,
    kit,
    project,
  }) => {
    expect((await aireg(["init", "-y"])).code).toBe(0);
    // Only this one artifact's entry names these tools, so they leave the manifest with it.
    const added = await aireg(["add", kit, "-s", "lint", "--for", "grok,cursor", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".agents", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(added.stderr).toContain(GROK_TRUST);
    expect(added.stderr).toContain(GROK_RELOAD);
    expect(added.stderr).toContain(CURSOR_RELOAD);

    const removed = await aireg(["remove", "lint", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(join(project, ".agents", "skills", "lint"))).toBe(false);
    expect(removed.stderr).toContain(GROK_RELOAD);
    expect(removed.stderr).toContain(CURSOR_RELOAD);
    expect(removed.stderr).not.toContain(GROK_TRUST);
  });
});
