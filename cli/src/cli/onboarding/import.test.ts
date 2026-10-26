import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { acquire } from "#core/lease.ts";
import { roots } from "#core/store/paths.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { applyImport, planImport } from "./import.ts";

/** A git project in the test's home holding one skill to import. */
const test = base.extend("project", async ({ home }) => {
  const dir = join(home.dir, "project");
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, ".claude", "skills", "explain"), { recursive: true });
  await writeFile(
    join(dir, ".claude", "skills", "explain", "SKILL.md"),
    "---\nname: explain\n---\nlocal\n",
  );
  return dir;
});

describe("applyImport", () => {
  test("waits for the scope's lease before writing the lock", async ({ project: base }) => {
    const plan = await planImport(base, ["claude-code"], "project");
    expect(plan.artifacts.map(({ name }) => name)).toEqual(["explain"]);

    const scope = roots("project", base);
    const lease = await acquire(scope);
    let settled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const applying = applyImport(plan, { registry: "acme", namespace: "eng" }).finally(() => {
        settled = true;
      });
      // A pending poll is apply waiting on the lease rather than writing.
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      expect(settled).toBe(false);

      await lease.release();
      await vi.advanceTimersToNextTimerAsync();
      await expect(applying).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(await readFile(scope.lock, "utf8")).toContain("eng/explain");
  });

  test("leaves no copy behind when a later artifact is refused", async ({ project: base }) => {
    await mkdir(join(base, ".claude", "skills", "zz-late"), { recursive: true });
    await writeFile(
      join(base, ".claude", "skills", "zz-late", "SKILL.md"),
      "---\nname: zz-late\n---\nlocal\n",
    );
    const plan = await planImport(base, ["claude-code"], "project");
    expect(plan.artifacts.map(({ name }) => name)).toEqual(["explain", "zz-late"]);
    // A link that appears after the plan was checked, as only a race makes one.
    await writeFile(join(base, "..", "outside.txt"), "CANARY");
    await symlink(
      join(base, "..", "outside.txt"),
      join(base, ".claude", "skills", "zz-late", "x.md"),
    );

    await expect(applyImport(plan, { registry: "acme", namespace: "eng" })).rejects.toThrow();
    const artifacts = join(base, ".registry", "artifacts");
    const left = await readdir(artifacts, { recursive: true }).catch(() => []);
    expect(left.filter((entry) => String(entry).endsWith("SKILL.md"))).toEqual([]);
  });
});

describe("planImport", () => {
  test("refuses a skill holding a link, before anything is copied", async ({ project: base }) => {
    const outside = join(base, "..", "outside.txt");
    await writeFile(outside, "CANARY");
    await symlink(outside, join(base, ".claude", "skills", "explain", "notes.md"));

    await expect(planImport(base, ["claude-code"], "project")).rejects.toThrow(
      "Did not import .claude/skills/explain/notes.md: it is a symlink; an artifact holds regular files only.",
    );
    await expect(lstat(join(base, ".registry", "artifacts"))).rejects.toThrow();
  });
});
