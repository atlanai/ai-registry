import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

// A `depends_on` edge may name another registry by its canonical URL. It resolves only in a
// registry this project declares at that URL, and an undeclared one fails the install.

const PLATFORM = "https://github.com/acme/agent-registry";

let aireg: Aireg;
let market: string;
let platform: string;
let project: string;

/** `sql-style` at each version given, in a registry whose `registry.json` names its URL. */
async function publishPlatform(...versions: string[]): Promise<void> {
  const built = registry(platform, { name: "platform", slug: "acme", url: `${PLATFORM}/` });
  for (const version of versions) {
    built.skill(`platform/sql-style@${version}`, { body: `style ${version}\n` });
  }
  await built.write();
}

interface Row {
  registry?: string;
  version?: string;
  needed_by?: string[];
  depends_on?: Record<string, string>;
}
const lockfile = async () =>
  parse(await readFile(lockPath(project), "utf8")) as {
    registries?: Record<string, { url?: string }>;
    artifacts?: Record<string, Row>;
  };
const lock = async (): Promise<Record<string, Row>> => (await lockfile()).artifacts ?? {};
const style = () => readFile(join(project, ".claude", "skills", "sql-style", "SKILL.md"), "utf8");

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, market, platform, project] = [run, join(tmp, "market"), join(tmp, "platform"), dir];
  await mkdir(join(project, ".claude"), { recursive: true });
  await registry(market, { name: "acme", slug: "acme" })
    .agent("eng/reviewer@0.3.0", {
      body: "agent\n",
      dependsOn: [{ to: "platform/skill/sql-style@1.2.0", range: "^1.2.0", registry: PLATFORM }],
    })
    .skill("eng/notes@1.0.0", { body: "notes\n" })
    .write();
  await publishPlatform("1.2.0", "1.3.0", "2.0.0");
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
}, 60_000);

describe("a dependency in another registry", () => {
  test("fails the install when this project does not declare that registry", async () => {
    const before = await readFile(manifestPath(project), "utf8");
    const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      `eng/agent/reviewer needs platform/skill/sql-style from ${PLATFORM}, which this project does not declare.`,
    );
    expect(added.stderr).toContain(`Run \`aireg registry add ${PLATFORM}\` to allow it.`);
    expect(await readFile(manifestPath(project), "utf8")).toBe(before);
    expect(await readFile(lockPath(project), "utf8").catch(() => "")).not.toContain("reviewer");
  }, 60_000);

  test("installs from the registry declared at that URL, and records it", async () => {
    // Declared from a folder, the registry is known by the URL its registry.json names.
    expect((await aireg(["registry", "add", platform, "--as", "platform"])).code).toBe(0);
    const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await style()).toContain("style 1.3.0");
    const rows = await lock();
    expect(rows["sql-style"]).toMatchObject({
      registry: "platform",
      version: "1.3.0",
      needed_by: ["reviewer"],
    });
    expect(rows.reviewer).toMatchObject({
      registry: "acme",
      depends_on: { "sql-style": "^1.2.0" },
    });
    // A folder's URL is recorded, so the next run matches the edge without reading it again.
    expect((await lockfile()).registries?.platform?.url).toBe(PLATFORM);
  }, 60_000);

  test("installs from the lock as it is, and moves within the range only on update", async () => {
    const before = await readFile(lockPath(project), "utf8");
    await publishPlatform("1.2.0", "1.3.0", "1.4.0", "2.0.0");
    await rm(join(project, ".registry", "artifacts"), { recursive: true, force: true });
    await rm(join(project, ".claude"), { recursive: true, force: true });
    await mkdir(join(project, ".claude"));

    const frozen = await aireg(["install", "--frozen", "-y"]);
    expect(frozen.code, frozen.stderr).toBe(0);
    expect(await style()).toContain("style 1.3.0");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
    // Planned from the lockfile alone, the dependency is still reached in its own registry.
    const again = await aireg(["install", "--frozen", "-y"]);
    expect(again.code, again.stderr).toBe(0);
    expect(await style()).toContain("style 1.3.0");

    const updated = await aireg(["update", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(await style()).toContain("style 1.4.0");
    expect((await lock())["sql-style"]).toMatchObject({ registry: "platform", version: "1.4.0" });
  }, 60_000);

  test("matches the edge by the recorded URL after that registry's folder moves away", async () => {
    const away = `${platform}-away`;
    await rename(platform, away);
    try {
      const added = await aireg(["add", "acme/eng/skill/notes", "-y"]);
      expect(added.code, added.stderr).toBe(0);
      expect((await lock())["sql-style"]).toMatchObject({ registry: "platform", version: "1.4.0" });
    } finally {
      await rename(away, platform);
    }
    expect((await aireg(["remove", "notes", "-y"])).code).toBe(0);
  }, 60_000);

  test("refuses an edge's URL that two declared registries are at, naming both", async () => {
    // A second folder whose registry.json claims the same URL could serve anything under it.
    const claimant = `${platform}-claimant`;
    await registry(claimant, { name: "aaa", slug: "aaa", url: PLATFORM })
      .skill("platform/sql-style@1.9.0", { body: "not the platform's\n" })
      .write();
    expect((await aireg(["registry", "add", claimant, "--as", "aaa"])).code).toBe(0);
    const updated = await aireg(["update", "-y"]);
    expect(updated.code).toBe(1);
    expect(updated.stderr).toContain(
      `eng/agent/reviewer needs platform/skill/sql-style from ${PLATFORM}, and 2 declared registries are at that URL: "aaa" and "platform".`,
    );
    expect(updated.stderr).toContain("aireg registry remove <name>");
    expect(await style()).toContain("style 1.4.0");
    expect((await aireg(["registry", "remove", "aaa"])).code).toBe(0);
  }, 60_000);

  test("fails once that registry is no longer declared, naming where the lockfile found it", async () => {
    expect((await aireg(["registry", "remove", "platform"])).code).toBe(0);
    const installed = await aireg(["install", "-y"]);
    expect(installed.code).toBe(1);
    expect(installed.stderr).toContain("eng/agent/reviewer needs platform/skill/sql-style from ");
    expect(installed.stderr).toContain(", which this project does not declare.");
    expect(installed.stderr).toContain(" --as platform` to allow it.");
    expect((await lock())["sql-style"]).toMatchObject({ registry: "platform", version: "1.4.0" });
  }, 60_000);
});
