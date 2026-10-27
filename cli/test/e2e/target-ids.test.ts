import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { claudeCode } from "#targets/claude-code.ts";
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
    expect((await aireg(["init", "-y", "--for", "claude-code,agents"])).code).toBe(0);
    // aireg 0.1 refuses `targets:` and today's ids, so a new manifest keeps its names.
    expect(await read(project, "manifest.yml")).toContain("harnesses:\n  - claude\n  - agents\n");
    const added = await aireg(["add", kit, "--all", "--for", "claude,agents", "--yes"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".claude", "skills", "lint", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "lint", "SKILL.md"))).toBe(true);
    const lock = await read(project, "manifest.lock.yml");
    expect(lock).toContain("- target: claude-code\n");
    expect(lock).toContain("- target: universal\n");
    expect(lock).not.toMatch(/target: (claude|agents)\n/);
    expect(await read(project, "manifest.yml")).not.toMatch(/targets|claude-code|universal/);
  });

  test("is written as today's id once a file of yours gives the target other ids", async ({
    aireg,
    home,
    kit,
    project,
  }) => {
    const { default: _, importable: __, detect, ...definition } = claudeCode;
    const { caller: ___, ...signals } = detect as Exclude<typeof detect, "never" | undefined>;
    await mkdir(join(home.aireg, "targets"), { recursive: true });
    await writeFile(
      join(home.aireg, "targets", "claude-code.json"),
      JSON.stringify({ ...definition, detect: signals, aliases: ["cc"], overrides: true }),
    );
    expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
    expect(await read(project, "manifest.yml")).toContain("harnesses:\n  - claude-code\n");
    const added = await aireg(["add", kit, "-s", "lint", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await read(project, "manifest.lock.yml")).toContain(
      "- target: claude-code\n        harness: claude-code\n",
    );
    const listed = await aireg(["list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).data.artifacts[0].targets).toEqual(["claude-code"]);
  });

  test("prints each target under its aireg 0.1 key and id too", async ({ aireg, kit }) => {
    expect((await aireg(["init", "-y", "--for", "gemini-cli,claude-code"])).code).toBe(0);
    const added = await aireg(["add", kit, "-s", "lint", "-y"]);
    expect(added.code, added.stderr).toBe(0);

    const status = JSON.parse((await aireg(["status", "--json"])).stdout);
    const [row] = status.data.artifacts;
    expect(row.targets).toEqual({ "claude-code": "linked", "gemini-cli": "linked" });
    expect(row.harnesses).toEqual({ claude: "linked", gemini: "linked" });
    expect(row.needsApproval).toEqual([
      { target: "gemini-cli", harness: "gemini", run: "/permissions trust" },
    ]);

    const rows = JSON.parse((await aireg(["list", "--json"])).stdout).data.artifacts;
    expect(rows[0].targets).toEqual(["claude", "gemini"]);

    const detail = JSON.parse((await aireg(["list", "kit/lint", "--json"])).stdout);
    expect(
      detail.data.links.map(({ target, harness }: Record<string, string>) => [target, harness]),
    ).toEqual([
      ["claude-code", "claude"],
      ["gemini-cli", "gemini"],
    ]);

    const listed = JSON.parse((await aireg(["targets", "--all", "--json"])).stdout).data;
    expect(listed.targets.map((row: { name: string }) => row.name)).toContain("gemini-cli");
    expect(listed.harnesses.find((row: { name: string }) => row.name === "gemini")).toMatchObject({
      displayName: "Gemini CLI",
      kind: "coding",
    });
    const shown = JSON.parse((await aireg(["targets", "show", "universal", "--json"])).stdout).data;
    expect(shown.target.name).toBe("universal");
    expect(shown.harness).toMatchObject({ name: "agents", kind: "shared" });
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
    expect(await readFile(manifest, "utf8")).toContain("harnesses:\n  - claude\n  - agents\n");
    const lock = await readFile(lockfile, "utf8");
    await writeFile(lockfile, lock.replaceAll(/target: [^\n]+\n\s*harness:/g, "harness:"));
    return { manifest, lockfile };
  }

  test("reads clean, installs frozen, and keeps its names through the next change", async ({
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
    const edited = await readFile(manifest, "utf8");
    expect(edited).toContain("harnesses:\n  - claude\n  - agents\n");
    expect(edited).not.toMatch(/targets|claude-code|universal/);
    // `harness:` beside each `target:`, so a teammate still on aireg 0.1 reads the lock.
    const lock = await readFile(lockfile, "utf8");
    expect(lock).toContain("version: 1\n");
    expect(lock).toContain("- target: claude-code\n        harness: claude\n");
    expect(lock).toContain("- target: universal\n        harness: agents\n");
  });

  test("leaves the manifest as it is on an install that changes the lock", async ({
    aireg,
    kit,
    project,
  }) => {
    const { manifest, lockfile } = await earlierProject(aireg, `${kit}`, project);
    const before = await readFile(manifest, "utf8");
    await rm(lockfile);
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(manifest, "utf8")).toBe(before);
  });

  test("keeps `targets:` and today's ids once someone writes `targets:`", async ({
    aireg,
    kit,
    project,
  }) => {
    const { manifest } = await earlierProject(aireg, `${kit}`, project);
    const text = await readFile(manifest, "utf8");
    await writeFile(manifest, text.replace("harnesses:", "targets:"));
    const more = await aireg(["add", `${kit}`, "-s", "fmt", "-y"]);
    expect(more.code, more.stderr).toBe(0);
    const edited = await readFile(manifest, "utf8");
    expect(edited).toContain("targets:\n  - claude-code\n  - universal\n");
    expect(edited).not.toContain("harnesses");
  });
});
