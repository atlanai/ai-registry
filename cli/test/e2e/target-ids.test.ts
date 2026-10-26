import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
  test("reads clean, installs frozen, and is rewritten by the next change", async ({
    aireg,
    kit,
    project,
  }) => {
    expect((await aireg(["init", "-y", "--for", "claude-code,universal"])).code).toBe(0);
    const added = await aireg(["add", `${kit}`, "-s", "lint", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    // What an earlier aireg wrote: `harnesses:`, `harness:` and the earlier ids.
    const manifest = join(project, ".registry", "manifest.yml");
    const lockfile = join(project, ".registry", "manifest.lock.yml");
    const earlier = (text: string) =>
      text
        .replaceAll("targets:", "harnesses:")
        .replaceAll("target:", "harness:")
        .replaceAll("claude-code", "claude")
        .replaceAll("universal", "agents");
    await writeFile(manifest, earlier(await readFile(manifest, "utf8")));
    await writeFile(lockfile, earlier(await readFile(lockfile, "utf8")));
    expect(await readFile(lockfile, "utf8")).toContain("- harness: claude\n");

    const status = await aireg(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const { data } = JSON.parse(status.stdout);
    expect(data.artifacts.map((item: { state: string }) => item.state)).toEqual(["ok"]);
    expect(data.artifacts[0].targets).toEqual({ "claude-code": "linked", universal: "linked" });

    const frozen = await aireg(["install", "--frozen"]);
    expect(frozen.code, frozen.stderr).toBe(0);

    const more = await aireg(["add", `${kit}`, "-s", "fmt", "-y"]);
    expect(more.code, more.stderr).toBe(0);
    const rewritten = await readFile(manifest, "utf8");
    expect(rewritten).toContain("targets:\n  - claude-code\n  - universal\n");
    expect(rewritten).not.toContain("harnesses");
    const lock = await readFile(lockfile, "utf8");
    expect(lock).not.toContain("harness");
    expect(lock).toContain("- target: claude-code\n");
  });
});
