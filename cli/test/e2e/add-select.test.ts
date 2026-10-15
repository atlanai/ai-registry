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

  test("installs a member whose name is taken under its namespace and name, across releases", async ({
    aireg,
    newProject: project,
    tmp,
  }) => {
    // Its own registry, so a later release doesn't reach the shared one.
    const teams = join(tmp, "teams");
    const publish = (versions: string[]) => {
      const built = registry(teams, { name: "teams", slug: "teams" });
      built.skill("eng/review@1.0.0", { description: "eng" });
      for (const version of versions) {
        built.skill(`ops/review@${version}`, { description: "ops", body: `ops ${version}\n` });
      }
      return built.write();
    };
    await publish(["1.0.0"]);
    const dir = await project();
    expect((await aireg(["registry", "add", teams], { cwd: dir })).code).toBe(0);
    expect((await aireg(["add", "teams/eng", "-y"], { cwd: dir })).code).toBe(0);
    const added = await aireg(["add", "teams/ops", "-y"], { cwd: dir });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout + added.stderr).toContain(
      "renamed  ops/review to ops-review, because review is taken by eng/review",
    );
    const copy = join(dir, ".claude", "skills", "ops-review", "SKILL.md");
    const kept = join(dir, ".claude", "skills", "review", "SKILL.md");
    expect(await readFile(copy, "utf8")).toMatch(/^name: ops-review$/m);
    expect(await readFile(kept, "utf8")).toMatch(/^name: review$/m);
    expect((await aireg(["status"], { cwd: dir })).code).toBe(0);

    await publish(["1.0.0", "1.1.0"]);
    const updated = await aireg(["update", "-y"], { cwd: dir });
    expect(updated.code, updated.stderr).toBe(0);
    expect(await readFile(copy, "utf8")).toContain("ops 1.1.0");
    expect(await readFile(copy, "utf8")).toMatch(/^name: ops-review$/m);
    expect((await aireg(["status"], { cwd: dir })).code).toBe(0);
  }, 60_000);

  test("leaves a member whose name is taken out, or installs nothing, as the setting says", async ({
    aireg,
    market,
    newProject: project,
  }) => {
    const dir = await project();
    expect((await aireg(["registry", "add", market], { cwd: dir })).code).toBe(0);
    expect((await aireg(["add", "kit/engineering/pr-review", "-y"], { cwd: dir })).code).toBe(0);
    const before = await manifest(dir);

    expect((await aireg(["config", "set", "defaults.name-collision", "fail"])).code).toBe(0);
    const failed = await aireg(["add", "kit/design", "-y"], { cwd: dir });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain(
      "Nothing was installed: design/pr-review needs the name pr-review, which engineering/pr-review already has.",
    );
    expect(await manifest(dir)).toBe(before);

    expect((await aireg(["config", "set", "defaults.name-collision", "report"])).code).toBe(0);
    const added = await aireg(["add", "kit/design", "-y"], { cwd: dir });
    expect(added.code).toBe(3);
    expect(added.stdout + added.stderr).toContain(
      "skipped  design/pr-review, because pr-review is taken by engineering/pr-review",
    );
    const copy = join(dir, ".claude", "skills", "pr-review", "SKILL.md");
    expect(await readFile(copy, "utf8")).toContain("engineering");
    expect(existsSync(join(dir, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
    // A teammate's install says so too, rather than reporting success.
    expect((await aireg(["install"], { cwd: dir })).code).toBe(3);
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
    // Written with forward slashes on every system, so the manifest travels.
    expect(await manifest(dir)).toContain(`kit: ${relativeMarket.replaceAll("\\", "/")}`);
    const sub = join(dir, "sub");
    await mkdir(sub);
    const added = await aireg(["add", "kit/design/deploy", "-y"], { cwd: sub });
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(dir, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
  }, 60_000);
});
