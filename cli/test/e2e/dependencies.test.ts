import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { declared, lockPath, manifestPath } from "#test/kit/scope.ts";

let aireg: Aireg;
let market: string;
let project: string;

/** `reviewer` needs `pr-review`, which needs `lint` at an older version than latest. */
async function publish(next = false): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  const add = (kind: "skill" | "agent", ref: string, ...dependsOn: string[]) => {
    const version = ref.split("@")[1];
    built[kind](ref, { body: `${kind === "skill" ? "body" : "agent"} ${version}\n`, dependsOn });
  };
  add("skill", "eng/lint@1.0.0");
  add("skill", "eng/lint@2.0.0");
  add("skill", "eng/pr-review@1.1.0");
  add("skill", "eng/pr-review@1.2.0", "eng/skill/lint@1.0.0");
  if (next) add("skill", "eng/pr-review@1.3.0");
  add("agent", "eng/reviewer@0.3.0", "eng/skill/pr-review@1.2.0");
  if (next) add("agent", "eng/reviewer@0.4.0", "eng/skill/pr-review@1.3.0");
  add("agent", "eng/helper@1.0.0", "eng/skill/pr-review@1.2.0");
  add("agent", "eng/triage@1.0.0", "eng/skill/pr-review@1.1.0");
  add("skill", "eng/ping@1.0.0", "eng/skill/pong@1.0.0");
  add("skill", "eng/pong@1.0.0", "eng/skill/ping@1.0.0");
  // A namespace whose agent needs an older version of one of its own skills.
  add("skill", "ops/fmt@1.0.0");
  add("skill", "ops/fmt@2.0.0");
  add("agent", "ops/formatter@1.0.0", "ops/skill/fmt@1.0.0");
  await built.write();
}

interface Row {
  version?: string;
  needed_by?: string[];
}
const lock = async (): Promise<Record<string, Row>> =>
  (parse(await readFile(lockPath(project), "utf8")) as { artifacts?: Record<string, Row> })
    .artifacts ?? {};
const skillFile = (name: string) =>
  readFile(join(project, ".claude", "skills", name, "SKILL.md"), "utf8");
const manifest = () => readFile(manifestPath(project), "utf8");

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, market, project] = [run, join(tmp, "market"), dir];
  await mkdir(join(project, ".claude"), { recursive: true });
  await publish();
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
});

describe("what an artifact depends on", () => {
  test("installs the versions its edges name, transitively, and records them in the lock only", async () => {
    expect((await aireg(["add", "acme/eng/agent/reviewer", "-y"])).code).toBe(0);
    expect(await skillFile("pr-review")).toContain("body 1.2.0");
    // The edge names 1.0.0, so latest (2.0.0) is not what installs.
    expect(await skillFile("lint")).toContain("body 1.0.0");
    expect(declared(await manifest())).not.toMatch(/pr-review|lint/);
    const rows = await lock();
    expect(rows["pr-review"]?.needed_by).toEqual(["reviewer"]);
    expect(rows.lint?.needed_by).toEqual(["pr-review"]);
    expect(rows.reviewer?.needed_by).toBeUndefined();
    expect((await aireg(["list"])).stdout).toMatch(/pr-review .* reviewer/);
    // Its dependencies stay in sync with the registry, at the versions the edges name.
    const synced = await aireg(["sync", "--dry-run"]);
    expect(synced.stdout, synced.stderr).toContain("In sync with every registry (3 artifacts).");
    expect(synced.code).toBe(0);
  });

  test("refuses two versions of one dependency, naming both, and changes nothing", async () => {
    const before = await manifest();
    const added = await aireg(["add", "acme/eng/agent/triage", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("eng/skill/pr-review is needed at two versions");
    expect(added.stderr).toContain("1.2.0 by eng/agent/reviewer");
    expect(added.stderr).toContain("1.1.0 by eng/agent/triage");
    expect(await manifest()).toBe(before);
    expect(existsSync(join(project, ".claude", "agents", "triage.md"))).toBe(false);
  });

  test("prunes on remove only what nothing else needs", async () => {
    expect((await aireg(["add", "acme/eng/agent/helper", "-y"])).code).toBe(0);
    expect((await aireg(["remove", "reviewer", "-y"])).code).toBe(0);
    expect((await lock())["pr-review"]?.needed_by).toEqual(["helper"]);
    expect(await skillFile("lint")).toContain("body 1.0.0");

    const dry = await aireg(["remove", "helper", "--dry-run"]);
    expect(dry.stdout).toMatch(/pr-review .* no longer needed/);
    expect((await aireg(["remove", "helper", "-y"])).code).toBe(0);
    expect(Object.keys(await lock())).toEqual([]);
    expect(existsSync(join(project, ".claude", "skills", "lint"))).toBe(false);
  });

  test("installs a cycle once, and removes it whole", async () => {
    expect((await aireg(["add", "acme/eng/skill/ping", "-y"])).code).toBe(0);
    const rows = await lock();
    expect(rows.pong?.needed_by).toEqual(["ping"]);
    expect(rows.ping?.needed_by).toEqual(["pong"]);
    expect((await aireg(["remove", "ping", "-y"])).code).toBe(0);
    expect(Object.keys(await lock())).toEqual([]);
  });

  test("keeps a dependency named for removal, says so, and moves a folder of yours aside", async () => {
    expect((await aireg(["add", "acme/eng/agent/reviewer", "-y"])).code).toBe(0);
    const own = join(project, ".claude", "skills", "pr-review");
    await rm(own, { recursive: true });
    await mkdir(own);
    await writeFile(join(own, "SKILL.md"), "my own work\n");

    const removed = await aireg(["remove", "pr-review", "-y"]);
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("Kept pr-review: reviewer needs it.");
    expect(removed.stderr).toMatch(
      /Moved your folder \.claude\/skills\/pr-review to \.registry\/backups\/\d{8}T\d{6}Z\/claude-code\/skills\/pr-review\./,
    );
    expect(removed.stdout).not.toContain("Updated");
    expect((await lock())["pr-review"]?.needed_by).toEqual(["reviewer"]);

    expect((await aireg(["remove", "reviewer", "-y"])).code).toBe(0);
    expect(Object.keys(await lock())).toEqual([]);
  });

  test("installs dependencies from the lock, and moves them only on update", async () => {
    expect((await aireg(["add", "acme/eng/agent/reviewer", "-y"])).code).toBe(0);
    const before = await readFile(lockPath(project), "utf8");
    await publish(true);
    await rm(join(project, ".registry", "artifacts"), { recursive: true, force: true });
    await rm(join(project, ".claude", "skills"), { recursive: true, force: true });

    expect((await aireg(["install", "-y"])).code).toBe(0);
    expect(await skillFile("lint")).toContain("body 1.0.0");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);

    expect((await aireg(["update", "-y"])).code).toBe(0);
    const rows = await lock();
    expect(rows.reviewer?.version).toBe("0.4.0");
    expect(rows["pr-review"]?.version).toBe("1.3.0");
    expect(rows.lint).toBeUndefined();
  });

  test("installs a namespace's skill at the version its agent needs, unless you named another", async () => {
    expect((await aireg(["add", "acme/ops", "-y"])).code).toBe(0);
    const rows = await lock();
    expect(rows["ops/fmt"]?.version).toBe("1.0.0");
    expect(rows["ops/fmt"]?.needed_by).toEqual(["ops/formatter"]);

    const pinned = await aireg(["add", "acme/ops/skill/fmt@2.0.0", "-y"]);
    expect(pinned.code).toBe(1);
    expect(pinned.stderr).toContain("ops/agent/formatter needs ops/skill/fmt 1.0.0");
  });

  test("refuses under --frozen a removal that only edits the manifest, and syncs one once", async () => {
    const before = await manifest();
    const frozen = await aireg(["remove", "ops/fmt", "--frozen"]);
    expect(frozen.code).toBe(3);
    expect(frozen.stderr).toContain("The manifest would change.");
    expect(await manifest()).toBe(before);

    expect((await aireg(["remove", "ops/fmt", "-y"])).code).toBe(0);
    expect(await manifest()).toMatch(/exclude:\n\s+- skill\/fmt/);
    const synced = await aireg(["sync", "--dry-run"]);
    expect(synced.code, synced.stdout).toBe(0);
    expect(synced.stdout).toContain("In sync with every registry");
  });
});
