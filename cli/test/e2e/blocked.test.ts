import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";

let aireg: Aireg;
let market: string;
let project: string;

/** `lint` blocked or not, and needed by `reviewer`; `format` gains a version beside it; `gate` is blocked and `sketch` a draft. */
async function publish(options: { blocked: boolean; format: readonly string[] }): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  built.skill("acme/lint@1.0.0", { body: "lint 1.0.0\n" });
  built.agent("acme/reviewer@0.1.0", { dependsOn: ["acme/skill/lint@1.0.0"] });
  for (const version of options.format) built.skill(`acme/format@${version}`, { body: version });
  built.skill("acme/gate@0.1.0").block("acme/gate@0.1.0", "leaks tokens");
  built.skill("acme/sketch@0.1.0", { status: "draft" });
  if (options.blocked) built.block("acme/lint@1.0.0", "leaks tokens");
  await built.write();
}

const lockedVersion = async (name: string): Promise<string | undefined> => {
  const lock = parse(await readFile(lockPath(project), "utf8")) as {
    artifacts: Record<string, { version?: string }>;
  };
  return lock.artifacts[name]?.version;
};
const installed = (name: string) =>
  readFile(join(project, ".claude", "skills", name, "SKILL.md"), "utf8");

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, market, project] = [run, join(tmp, "market"), dir];
  await publish({ blocked: false, format: ["1.0.0"] });
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  for (const address of ["acme/skill/lint", "acme/skill/format", "acme/agent/reviewer"]) {
    expect((await aireg(["add", address, "-y"])).code).toBe(0);
  }
}, 60_000);

describe("an installed artifact whose registry blocks it", () => {
  test("is kept by update, as its dependent's need, which names it and updates the rest", async () => {
    await publish({ blocked: true, format: ["1.0.0", "1.1.0"] });
    const updated = await aireg(["update", "-y"]);
    expect(updated.code).toBe(1);
    expect(updated.stderr).toContain(
      'acme/lint 1.0.0 is blocked (leaks tokens), so "lint" was kept at 1.0.0.',
    );
    expect(updated.stderr).toContain("Run `aireg remove lint` to take it out.");
    expect(await installed("lint")).toContain("lint 1.0.0");
    expect(await lockedVersion("lint")).toBe("1.0.0");
    expect(await lockedVersion("format")).toBe("1.1.0");
  }, 60_000);

  test("is kept by sync, which leaves it for you", async () => {
    const synced = await aireg(["sync"]);
    expect(synced.code).toBe(3);
    expect(`${synced.stdout}${synced.stderr}`).toContain(
      "acme/lint 1.0.0 is blocked (leaks tokens)",
    );
    expect(await installed("lint")).toContain("lint 1.0.0");
    expect(await lockedVersion("lint")).toBe("1.0.0");
  }, 60_000);
});

describe("adding an artifact its registry withholds", () => {
  test("refuses a blocked version, even pinned", async () => {
    const added = await aireg(["add", "acme/skill/gate@0.1.0", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      "acme/gate 0.1.0 is blocked (leaks tokens), so nothing was installed.",
    );
  }, 60_000);

  test("takes a draft only when pinned", async () => {
    const unpinned = await aireg(["add", "acme/skill/sketch", "-y"]);
    expect(unpinned.code).toBe(1);
    expect(unpinned.stderr).toContain("acme/sketch 0.1.0 is a draft, so nothing was installed.");
    const pinned = await aireg(["add", "acme/skill/sketch@0.1.0", "-y"]);
    expect(pinned.code, pinned.stderr).toBe(0);
    expect(await lockedVersion("sketch")).toBe("0.1.0");
  }, 60_000);
});
