import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("list");

test("list prints data its schema describes, for all and for one", async ({
  aireg,
  project,
  tmp,
}) => {
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("eng/lint@1.0.0")
    .agent("eng/reviewer@1.0.0", { dependsOn: ["eng/skill/lint@1.0.0"] })
    .write();
  await writeManifestIn(
    project,
    `targets:\n  - claude\n  - codex\nregistries:\n  acme: ${JSON.stringify(market)}\nartifacts: []\n`,
  );
  const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
  expect(added.code, added.stderr).toBe(0);

  expect(await contract.violations(aireg, ["list"], "list")).toBe("");
  // `lint` is installed only for `reviewer`, so both forms carry `neededBy`.
  expect(await contract.violations(aireg, ["list", "lint"], "list")).toBe("");
  expect(await contract.violations(aireg, ["list", "reviewer"], "list")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
