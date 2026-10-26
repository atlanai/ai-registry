import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";

const test = base.extend("kit", async ({ tmp }) =>
  registry(join(tmp, "kit"))
    .skill("kit/lint@1.0.0", { description: "Lint it." })
    .skill("kit/fmt@1.0.0", { description: "Format it." })
    .write(),
);

const read = (project: string, file: string) => readFile(join(project, ".registry", file), "utf8");

describe("a target's earlier id", () => {
  test("installs as the id it has now, into the same folders", async ({ aireg, kit, project }) => {
    expect((await aireg(["init", "-y", "--for", "claude,agents"])).code).toBe(0);
    expect(await read(project, "manifest.yml")).toContain(
      "targets:\n  - claude-code\n  - universal\n",
    );
    const added = await aireg(["add", kit, "--all", "--for", "claude,agents", "--yes"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".claude", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "lint", "SKILL.md"))).toBe(true);
    const lock = await read(project, "manifest.lock.yml");
    expect(lock).toContain("- target: claude-code\n");
    expect(lock).toContain("- target: universal\n");
    expect(lock).not.toMatch(/target: (claude|agents)\n/);
    expect(await read(project, "manifest.yml")).not.toMatch(/\b(claude|agents)\b(?!-)/);
  });

  test("shows the same target by either id", async ({ aireg }) => {
    const byAlias = await aireg(["targets", "show", "claude", "--json"]);
    const byId = await aireg(["targets", "show", "claude-code", "--json"]);
    expect(byAlias.code, byAlias.stderr).toBe(0);
    expect(byAlias.stdout).toBe(byId.stdout);
    expect(JSON.parse(byId.stdout).data.target.name).toBe("claude-code");
  });

  test("answers `aireg harnesses` as `aireg targets`", async ({ aireg }) => {
    const before = await aireg(["targets", "--all", "--json"]);
    const earlier = await aireg(["harnesses", "--all", "--json"]);
    expect(earlier.code, earlier.stderr).toBe(0);
    expect(earlier.stdout).toBe(before.stdout);
    expect((await aireg(["--help"])).stdout).not.toContain("harnesses");
  });
});

describe("a project an earlier aireg wrote", () => {
  /** A project as aireg 0.1 leaves it: `harnesses:`, `harness:` and the earlier ids. */
  async function earlierProject(
    aireg: (argv: string[]) => Promise<{ code: number; stderr: string }>,
    kit: string,
    project: string,
  ): Promise<{ manifest: string; lockfile: string }> {
    expect((await aireg(["init", "-y", "--for", "claude-code,universal"])).code).toBe(0);
    const added = await aireg(["add", kit, "-s", "lint", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    const manifest = join(project, ".registry", "manifest.yml");
    const lockfile = join(project, ".registry", "manifest.lock.yml");
    const text = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      text
        .replaceAll("targets:", "harnesses:")
        .replaceAll("claude-code", "claude")
        .replaceAll("universal", "agents"),
    );
    const lock = await readFile(lockfile, "utf8");
    await writeFile(lockfile, lock.replaceAll(/target: [^\n]+\n\s*harness:/g, "harness:"));
    return { manifest, lockfile };
  }

  test("reads clean, installs frozen, and moves to today's names with the next change", async ({
    aireg,
    kit,
    project,
  }) => {
    const { manifest, lockfile } = await earlierProject(aireg, `${kit}`, project);
    const before = await readFile(manifest, "utf8");

    const status = await aireg(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const { data } = JSON.parse(status.stdout);
    expect(data.artifacts.map((item: { state: string }) => item.state)).toEqual(["ok"]);
    expect(data.artifacts[0].targets).toEqual({ "claude-code": "linked", universal: "linked" });

    const frozen = await aireg(["install", "--frozen"]);
    expect(frozen.code, frozen.stderr).toBe(0);
    expect(await readFile(manifest, "utf8")).toBe(before);

    const more = await aireg(["add", `${kit}`, "-s", "fmt", "-y"]);
    expect(more.code, more.stderr).toBe(0);
    const rewritten = await readFile(manifest, "utf8");
    expect(rewritten).toContain("targets:\n  - claude-code\n  - universal\n");
    expect(rewritten).not.toContain("harnesses");
    // `harness:` beside each `target:`, so a teammate still on aireg 0.1 reads the lock.
    const lock = await readFile(lockfile, "utf8");
    expect(lock).toContain("version: 1\n");
    expect(lock).toContain("- target: claude-code\n        harness: claude\n");
    expect(lock).toContain("- target: universal\n        harness: agents\n");
  });

  test("moves the manifest over on an install that changes the lock", async ({
    aireg,
    kit,
    project,
  }) => {
    const { manifest, lockfile } = await earlierProject(aireg, `${kit}`, project);
    await rm(lockfile);
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(manifest, "utf8")).toContain(
      "targets:\n  - claude-code\n  - universal\n",
    );
  });
});
