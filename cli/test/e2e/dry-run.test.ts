import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";

const test = base.extend("kit", async ({ tmp }) =>
  registry(join(tmp, "kit")).skill("kit/lint@1.0.0", { description: "Lint it." }).write(),
);

/** Every file under the home, logs aside: a dry run may write a log and nothing else. */
async function written(home: string): Promise<string[]> {
  const entries = await readdir(home, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(home, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith(join(".aireg", "logs")))
    .sort();
}

describe("--dry-run", () => {
  test("previews declaring a registry without declaring it", async ({ aireg, home, kit }) => {
    const added = await aireg(["registry", "add", kit, "--as", "kit", "-g", "--dry-run"], {
      cwd: home.dir,
    });
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("Would add registry kit");
    expect(added.stdout).toContain("Dry run. Nothing was changed.");
    expect(await written(home.dir)).toEqual([]);
  });

  test("previews removing a registry without removing it", async ({ aireg, home, kit }) => {
    const cwd = home.dir;
    expect((await aireg(["registry", "add", kit, "--as", "kit", "-g"], { cwd })).code).toBe(0);
    const before = await written(home.dir);

    const removed = await aireg(["registry", "remove", "kit", "-g", "--dry-run"], { cwd });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Would remove registry kit");
    expect((await aireg(["registry", "list", "-g"], { cwd })).stdout).toContain("kit");
    expect(await written(home.dir)).toEqual(before);
  });

  test("leaves no lease folder in the project", async ({ aireg, project, kit }) => {
    await aireg(["init", "--for", "claude"]);
    expect((await aireg(["registry", "add", kit, "--as", "kit"])).code).toBe(0);
    const leases = join(project, ".registry", "leases");
    await rm(leases, { recursive: true, force: true });

    const ran = await aireg(["add", "kit", "--all", "--dry-run"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(existsSync(leases)).toBe(false);
  });
});

describe("aireg remove --dry-run", () => {
  test("says a folder of yours where a link was goes to backups", async ({
    aireg,
    project,
    kit,
  }) => {
    await aireg(["init", "--for", "claude"]);
    expect((await aireg(["registry", "add", kit, "--as", "kit"])).code).toBe(0);
    expect((await aireg(["add", "kit/kit/skill/lint", "-y"])).code).toBe(0);
    const link = join(project, ".claude", "skills", "lint");
    await rm(link);
    await mkdir(link);
    await writeFile(join(link, "SKILL.md"), "mine\n");

    const planned = await aireg(["remove", "lint", "--dry-run"]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stdout).toMatch(
      /move aside\s+lint\s+\.claude[\\/]skills[\\/]lint\s+yours, kept in backups/,
    );
    expect(planned.stdout).not.toContain("already up to date");
  });
});

describe("aireg sync <registry> --dry-run", () => {
  test("refuses a scope with no registry, as a real sync does", async ({ aireg }) => {
    await aireg(["init", "--for", "claude"]);
    for (const argv of [["sync", "--dry-run"], ["sync"]]) {
      const ran = await aireg(argv);
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(ran.stderr, argv.join(" ")).toContain("No registry is declared in this project.");
    }
  });

  test("refuses extra words, and takes a declared registry", async ({ aireg, kit }) => {
    await aireg(["init", "--for", "claude"]);
    expect((await aireg(["registry", "add", kit, "--as", "kit"])).code).toBe(0);
    expect((await aireg(["add", "kit", "-y"])).code).toBe(0);

    const extra = await aireg(["sync", "kit", "extra", "--dry-run"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain('takes at most one argument, not also "extra"');
    const named = await aireg(["sync", "kit", "--dry-run"]);
    expect(named.code, named.stderr).toBe(0);
  });
});

describe("--dry-run --json", () => {
  test("says it was a dry run, in the fields a real run fills", async ({ aireg, kit }) => {
    await aireg(["init", "--for", "claude"]);
    const data = async (...argv: string[]) => {
      const ran = await aireg([...argv, "--json"]);
      expect(ran.code, ran.stderr).toBe(0);
      return (JSON.parse(ran.stdout) as { data: Record<string, unknown> }).data;
    };

    const declare = ["registry", "add", kit, "--as", "kit"];
    expect(await data(...declare, "--dry-run")).toMatchObject({ registry: "kit", dryRun: true });
    expect(await data(...declare)).toMatchObject({ registry: "kit", address: kit, dryRun: false });
    expect(await data("add", "kit", "--all", "--dry-run")).toMatchObject({
      dryRun: true,
      installed: ["kit/lint"],
    });
    expect(await data("add", "kit", "--all")).toMatchObject({
      dryRun: false,
      installed: ["kit/lint"],
    });
    for (const argv of [["install"], ["update"], ["sync"]]) {
      expect(await data(...argv, "--dry-run")).toMatchObject({ dryRun: true });
    }
    expect(await data("remove", "lint", "--dry-run")).toMatchObject({
      dryRun: true,
      removed: ["kit/lint"],
    });
    expect(await data("remove", "--all")).toMatchObject({ dryRun: false, removed: ["kit/lint"] });
    expect(await data("registry", "remove", "kit", "--dry-run")).toEqual({
      registry: "kit",
      dryRun: true,
      jobs: [],
    });
  });
});
