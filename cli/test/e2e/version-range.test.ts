import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { declared, lockPath, manifestPath } from "#test/kit/scope.ts";

// A range in the manifest installs the newest version it admits, holds it in the lock, and
// lets `update` move only within it.

let aireg: Aireg;
let market: string;
let project: string;

/** Republishes the whole root at these versions of `lint`, which is how a registry gains one. */
async function publish(...versions: string[]): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  for (const version of versions)
    built.skill(`acme/lint@${version}`, { body: `body ${version}\n` });
  await built.write();
}

const installed = () => readFile(join(project, ".claude", "skills", "lint", "SKILL.md"), "utf8");
const manifest = async () => declared(await readFile(manifestPath(project), "utf8"));
const lockedVersion = async (): Promise<string | undefined> => {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, { version?: string }>;
  };
  return lock.artifacts.lint?.version;
};

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, market, project] = [run, join(tmp, "market"), dir];
  await mkdir(join(project, ".claude"), { recursive: true });
  await publish("1.0.0", "1.1.0", "2.0.0");
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
}, 60_000);

describe("a version range a project asks for", () => {
  test("installs the newest version in the range, and records the range as written", async () => {
    const added = await aireg(["add", "acme/skill/lint@^1", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await installed()).toContain("body 1.1.0");
    expect(await manifest()).toContain("acme/acme/skill/lint@^1");
    expect(await lockedVersion()).toBe("1.1.0");
  }, 60_000);

  test("holds the locked version on install, and moves within the range on update", async () => {
    await publish("1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0");
    const install = await aireg(["install", "-y"]);
    expect(install.code, install.stderr).toBe(0);
    expect(await lockedVersion()).toBe("1.1.0");

    const update = await aireg(["update", "lint", "-y"]);
    expect(update.code, update.stderr).toBe(0);
    expect(await installed()).toContain("body 1.2.0");
    expect(await lockedVersion()).toBe("1.2.0");
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect(await lockedVersion()).toBe("1.2.0");
  }, 60_000);

  test("moves to another range when one is added in its place", async () => {
    const added = await aireg(["add", "acme/skill/lint@~2.0", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("Pinned lint to versions ~2.0.");
    expect(await manifest()).toContain("acme/acme/skill/lint@~2.0");
    expect(await manifest()).not.toContain("@^1");
    expect(await lockedVersion()).toBe("2.0.0");
  }, 60_000);

  test("refuses a range no version satisfies, and changes nothing", async () => {
    const before = await manifest();
    const added = await aireg(["add", "acme/skill/lint@^3", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("acme/lint has no version in ^3.");
    expect(await manifest()).toBe(before);
    expect(await lockedVersion()).toBe("2.0.0");
  }, 60_000);

  test("is outdated only by a newer version in the range, and shows the newest outside it", async () => {
    // At 2.0.0 in ~2.0, with 2.1.0 published outside it.
    const held = await aireg(["outdated"]);
    expect(held.code, held.stderr).toBe(0);
    expect(held.stdout).toMatch(/ lint\s+acme\s+2\.0\.0 ~2\.0\s+2\.0\.0\s+2\.1\.0/);
    expect(held.stdout).not.toContain("aireg update");

    await publish("2.0.0", "2.0.1", "2.1.0");
    const behind = await aireg(["outdated"]);
    expect(behind.code, behind.stderr).toBe(3);
    expect(behind.stdout).toMatch(/ lint\s+acme\s+2\.0\.0 ~2\.0\s+2\.0\.1\s+2\.1\.0/);
    expect(behind.stdout).toContain("aireg update");
    const json = await aireg(["outdated", "--json"]);
    expect(JSON.parse(json.stdout).data.artifacts).toEqual([
      expect.objectContaining({
        name: "lint",
        current: "2.0.0",
        range: "~2.0",
        inRange: "2.0.1",
        latest: "2.1.0",
        moved: true,
      }),
    ]);

    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect(await lockedVersion()).toBe("2.0.1");
    expect((await aireg(["outdated"])).code).toBe(0);
  }, 60_000);
});
