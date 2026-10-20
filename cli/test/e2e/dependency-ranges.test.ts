import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

// A `depends_on` edge with a range installs the newest version every edge reaching it admits,
// records the range in the lockfile, and lets `update` move it within the range.

let aireg: Aireg;
let market: string;
let project: string;

/** `review` at each version given, and agents that need it at ranges that do or do not agree. */
async function publish(...reviews: string[]): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" });
  for (const version of reviews)
    built.skill(`eng/review@${version}`, { body: `body ${version}\n` });
  const agent = (ref: string, edge: string) =>
    built.agent(ref, { body: "agent\n", dependsOn: [`eng/skill/review@${edge}`] });
  agent("eng/reviewer@0.3.0", "0.3.2 ^0.3.2");
  agent("eng/triage@1.0.0", "0.3.4 ^0.3.4");
  agent("eng/auditor@1.0.0", "0.4.0 ^0.4.0");
  agent("eng/strict@1.0.0", "0.3.8 ~0.3.8");
  await built.write();
}

interface Row {
  version?: string;
  needed_by?: string[];
  depends_on?: Record<string, string>;
}
const lock = async (): Promise<Record<string, Row>> =>
  (parse(await readFile(lockPath(project), "utf8")) as { artifacts?: Record<string, Row> })
    .artifacts ?? {};
const review = () => readFile(join(project, ".claude", "skills", "review", "SKILL.md"), "utf8");

test.beforeAll(async ({ aireg: run, tmp, project: dir }) => {
  [aireg, market, project] = [run, join(tmp, "market"), dir];
  await mkdir(join(project, ".claude"), { recursive: true });
  await publish("0.3.2", "0.3.5", "0.4.0");
  expect((await aireg(["init", "-y"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
}, 60_000);

describe("a dependency asked for at a range", () => {
  test("installs the newest version in the range, and records the range", async () => {
    const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await review()).toContain("body 0.3.5");
    const rows = await lock();
    expect(rows.review?.version).toBe("0.3.5");
    expect(rows.review?.needed_by).toEqual(["reviewer"]);
    expect(rows.reviewer?.depends_on).toEqual({ review: "^0.3.2" });
  }, 60_000);

  test("shares one version between dependents whose ranges agree", async () => {
    const added = await aireg(["add", "acme/eng/agent/triage", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    const rows = await lock();
    expect(rows.review?.version).toBe("0.3.5");
    expect(rows.review?.needed_by).toEqual(["reviewer", "triage"]);
    expect(rows.triage?.depends_on).toEqual({ review: "^0.3.4" });
  }, 60_000);

  test("refuses ranges that do not overlap, naming each and who set it", async () => {
    const before = await readFile(manifestPath(project), "utf8");
    const added = await aireg(["add", "acme/eng/agent/auditor", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      "eng/skill/review is needed at versions that do not overlap: ^0.4.0 by eng/agent/auditor, ^0.3.2 by eng/agent/reviewer, and ^0.3.4 by eng/agent/triage.",
    );
    expect(await readFile(manifestPath(project), "utf8")).toBe(before);
  }, 60_000);

  test("refuses ranges that overlap where the registry publishes no version in all of them", async () => {
    const added = await aireg(["add", "acme/eng/agent/strict", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      "eng/skill/review is needed at ^0.3.2 by eng/agent/reviewer, ~0.3.8 by eng/agent/strict, and ^0.3.4 by eng/agent/triage, and acme publishes no version that satisfies all of them.",
    );
    expect((await lock()).strict).toBeUndefined();
  }, 60_000);

  test("installs from the lock as it is, and moves within the range only on update", async () => {
    const before = await readFile(lockPath(project), "utf8");
    await publish("0.3.2", "0.3.5", "0.3.9", "0.4.0");
    await rm(join(project, ".registry", "artifacts"), { recursive: true, force: true });
    await rm(join(project, ".claude"), { recursive: true, force: true });
    await mkdir(join(project, ".claude"));

    const frozen = await aireg(["install", "--frozen", "-y"]);
    expect(frozen.code, frozen.stderr).toBe(0);
    expect(await review()).toContain("body 0.3.5");
    expect(await readFile(lockPath(project), "utf8")).toBe(before);

    const updated = await aireg(["update", "review", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stderr).not.toContain("stays at");
    expect(await review()).toContain("body 0.3.9");
    const rows = await lock();
    expect(rows.review?.version).toBe("0.3.9");
    expect(rows.reviewer?.depends_on).toEqual({ review: "^0.3.2" });
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect((await lock()).review?.version).toBe("0.3.9");
  }, 60_000);
});
