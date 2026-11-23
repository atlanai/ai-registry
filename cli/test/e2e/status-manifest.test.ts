import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { manifestPath } from "#test/kit/scope.ts";

let aireg: Aireg;
let installed: string;

test.beforeAll(async ({ aireg: run, tmp, project }) => {
  aireg = run;
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("eng/pr-review@0.1.0", { body: "review 0.1.0\n" })
    .skill("eng/pr-review@0.1.1", { body: "review 0.1.1\n" })
    .skill("eng/lint@1.0.0", { body: "lint\n" })
    .write();
  expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  expect((await aireg(["add", "acme/eng/skill/pr-review@0.1.0", "-y"])).code).toBe(0);
  installed = await readFile(manifestPath(project), "utf8");
});

// `install --frozen` fails on each of these, so `status` must not report the project as in order.
describe("status after a hand edit to the manifest", () => {
  test("reports a pin the lockfile does not record", async ({ project }) => {
    await writeFile(manifestPath(project), installed.replace("@0.1.0", "@0.1.1"));
    const status = await aireg(["status"]);
    expect(status.code).toBe(3);
    expect(status.stdout).not.toContain("Everything matches the lockfile.");
    expect(status.stderr).toContain(
      "The manifest asks for acme/eng/skill/pr-review@0.1.1, which the lockfile does not record.",
    );
    expect(status.stderr).toContain("Run `aireg install` to make the lockfile match the manifest.");
    expect((await aireg(["install", "--frozen"])).code).toBe(3);
  });

  test("reports an entry the lockfile does not record, in --json too", async ({ project }) => {
    await writeFile(manifestPath(project), `${installed}  - acme/eng/skill/lint\n`);
    const status = await aireg(["status", "--json"]);
    expect(status.code).toBe(3);
    expect(JSON.parse(status.stdout).data.lockfile).toEqual({
      notLocked: ["acme/eng/skill/lint"],
      extraneous: [],
    });
  });

  test("reports an installed artifact the manifest no longer asks for", async ({ project }) => {
    await writeFile(
      manifestPath(project),
      installed.replace(/artifacts:[\s\S]*$/, "artifacts: []\n"),
    );
    const status = await aireg(["status"]);
    expect(status.code).toBe(3);
    expect(status.stderr).toContain(
      "The lockfile records pr-review, which the manifest no longer asks for.",
    );
  });

  test("matches again once the manifest is back", async ({ project }) => {
    await writeFile(manifestPath(project), installed);
    const status = await aireg(["status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("Everything matches the lockfile.");
    expect((await aireg(["install", "--frozen"])).code).toBe(0);
  });
});
