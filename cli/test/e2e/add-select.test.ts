import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

// `-s` reads inside the address it follows, never past it into another
// namespace; `--registry` names the registry apart from the address.

const test = base
  .extend("market", { scope: "file" }, ({ fileTmp }) =>
    // Two namespaces publish `pr-review`, which only a namespace tells apart.
    registry(join(fileTmp, "market"), { name: "kit", slug: "kit" })
      .skill("engineering/pr-review@1.0.0", {
        description: "engineering",
        body: "engineering 1.0.0\n",
      })
      .skill("engineering/pr-review@1.1.0", {
        description: "engineering",
        body: "engineering 1.1.0\n",
      })
      .skill("design/pr-review@1.0.0", { description: "design", body: "design 1.0.0\n" })
      .skill("engineering/lint@1.0.0", { description: "engineering", body: "engineering 1.0.0\n" })
      .skill("design/deploy@1.0.0", { description: "design", body: "design 1.0.0\n" })
      // A skill and an agent share `dup`, and only the skill has 1.1.0.
      .skill("engineering/dup@1.0.0", { description: "engineering" })
      .skill("engineering/dup@1.1.0", { description: "engineering" })
      .agent("engineering/dup@1.0.0", { description: "engineering" })
      .write(),
  )
  /** Each case starts from an empty project, so one install cannot satisfy the next. */
  .extend("newProject", ({ aireg, tmp }) => {
    let projects = 0;
    return async () => {
      const dir = join(tmp, `project-${++projects}`);
      await mkdir(join(dir, ".claude"), { recursive: true });
      expect((await aireg(["init", "-y"], { cwd: dir })).code).toBe(0);
      return dir;
    };
  });

const manifest = (dir: string) => readFile(manifestPath(dir), "utf8");

describe("aireg add -s", () => {
  test("picks inside the namespace the address names", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    const added = await aireg(["add", "kit/engineering", "-s", "pr-review", "-y"], { cwd: dir });
    expect(added.code, added.stderr).toBe(0);
    const text = await manifest(dir);
    expect(text).toContain("kit/engineering/skill/pr-review");
    expect(text).not.toContain("design");
  }, 60_000);

  test("takes a namespace and name inside a source", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    const added = await aireg(["add", market, "-s", "design/pr-review", "-y"], { cwd: dir });
    expect(added.code, added.stderr).toBe(0);
    const text = await manifest(dir);
    expect(text).toContain(`kit: ${market}`);
    expect(text).toContain("kit/design/skill/pr-review");
    expect(text).not.toContain("engineering");
  }, 60_000);

  test("refuses a name two namespaces share, and names both", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    const before = await manifest(dir);
    const failed = await aireg(["add", market, "-s", "pr-review", "-y"], { cwd: dir });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("matches 2 artifacts");
    expect(failed.stderr).toContain("kit/design/skill/pr-review");
    expect(failed.stderr).toContain("kit/engineering/skill/pr-review");
    expect(await manifest(dir)).toBe(before);
  }, 60_000);
});

describe("aireg add --registry", () => {
  test("declares a new source and installs the one artifact the address names", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    const added = await aireg(["add", "engineering/pr-review", "--registry", market, "-y"], {
      cwd: dir,
    });
    expect(added.code, added.stderr).toBe(0);
    const text = await manifest(dir);
    expect(text).toContain(`kit: ${market}`);
    expect(text).toContain("kit/engineering/skill/pr-review");
    expect(text).not.toContain("design");
  }, 60_000);

  test("writes the same manifest as the full address through a declared registry", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const full = await project();
    const short = await project();
    for (const dir of [full, short]) {
      expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    }
    expect((await aireg(["add", "kit/design/pr-review", "-y"], { cwd: full })).code).toBe(0);
    expect((await aireg(["add", "design/pr-review", "-r", "kit", "-y"], { cwd: short })).code).toBe(
      0,
    );
    expect(await manifest(short)).toBe(await manifest(full));
  }, 60_000);
});

describe("an address", () => {
  test("refuses a name a skill and an agent share, whatever version it gives", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    for (const argv of [
      ["show", "kit/engineering/dup@1.1.0"],
      ["show", "kit/engineering/dup@9.9.9"],
      ["add", "kit/engineering/dup@1.1.0", "-y"],
    ]) {
      const refused = await aireg(argv, { cwd: dir });
      expect(refused.code, argv.join(" ")).toBe(2);
      expect(refused.stderr).toContain(
        "Name one of them: kit/engineering/agent/dup or kit/engineering/skill/dup.",
      );
    }
    expect((await aireg(["show", "kit/engineering/skill/dup@1.1.0"], { cwd: dir })).code).toBe(0);
  }, 60_000);

  test("pins only the artifact it names", async ({ aireg, market, newProject: project }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    const added = await aireg(["add", "kit/engineering/pr-review@1.1.0", "-y"], { cwd: dir });
    expect(added.code, added.stderr).toBe(0);
    expect(await manifest(dir)).toContain("kit/engineering/skill/pr-review@1.1.0");
    const copy = join(dir, ".claude", "skills", "pr-review", "SKILL.md");
    expect(await readFile(copy, "utf8")).toContain("engineering 1.1.0");
  }, 60_000);

  test("refuses an artifact whose name another installed one already has", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    expect((await aireg(["add", "kit/engineering/pr-review", "-y"], { cwd: dir })).code).toBe(0);
    const before = await manifest(dir);
    const failed = await aireg(["add", "kit/design/pr-review", "-y"], { cwd: dir });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain(
      'kit/design/skill/pr-review and kit/engineering/skill/pr-review would both install as "pr-review".',
    );
    expect(await manifest(dir)).toBe(before);
  }, 60_000);

  test("installs the rest of a namespace whose member's name is taken, keeps the installed one, and exits 3", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    expect((await aireg(["add", "kit/engineering/pr-review", "-y"], { cwd: dir })).code).toBe(0);
    const added = await aireg(["add", "kit/design", "-y"], { cwd: dir });
    expect(added.code).toBe(3);
    expect(added.stderr).toContain(
      "kit/design/skill/pr-review reached no harness: kit/engineering/skill/pr-review already installs",
    );
    const copy = join(dir, ".claude", "skills", "pr-review", "SKILL.md");
    expect(await readFile(copy, "utf8")).toContain("engineering");
    expect(existsSync(join(dir, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);

    // The hint's fix: removing the installed one puts the newcomer in its place.
    expect(added.stderr).toContain("aireg remove kit/engineering/skill/pr-review");
    const removed = await aireg(["remove", "kit/engineering/skill/pr-review", "-y"], { cwd: dir });
    expect(removed.code, removed.stderr).toBe(0);
    expect(await readFile(copy, "utf8")).toContain("design");
  }, 60_000);

  test("keeps what each of several parallel adds wrote", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    const addresses = ["kit/engineering/pr-review", "kit/engineering/lint", "kit/design/deploy"];
    const runs = await Promise.all(
      addresses.map((address) => aireg(["add", address, "-y"], { cwd: dir })),
    );
    for (const run of runs) expect(run.code, run.stderr).toBe(0);
    const text = await manifest(dir);
    for (const name of ["pr-review", "lint", "deploy"]) {
      expect(text).toContain(`/skill/${name}`);
      expect(existsSync(join(dir, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
    const lock = await readFile(lockPath(dir), "utf8");
    for (const name of ["pr-review", "lint", "deploy"]) expect(lock).toContain(`  ${name}:`);
  }, 60_000);
});

describe("a namespace in your user scope", () => {
  test("names every artifact its plugin folder installs", async ({ aireg, market, home }) => {
    await mkdir(join(home.dir, ".claude"), { recursive: true });
    expect((await aireg(["registry", "add", market, "-g"], { cwd: home.dir })).code).toBe(0);
    const added = await aireg(["add", "kit/design", "-g", "-y", "--json"], { cwd: home.dir });
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).data.installed).toEqual(["design/deploy", "design/pr-review"]);
  }, 60_000);
});

describe("a folder registry", () => {
  test("is recorded relative to the project, and read from any folder in it", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    const relativeMarket = relative(dir, market);
    expect((await aireg(["registry", "add", relativeMarket], { cwd: dir })).code).toBe(0);
    expect(await manifest(dir)).toContain(`kit: ${relativeMarket}`);
    const sub = join(dir, "sub");
    await mkdir(sub);
    const added = await aireg(["add", "kit/design/deploy", "-y"], { cwd: sub });
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
  }, 60_000);
});
