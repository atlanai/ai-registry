import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("outdated");

test("outdated prints data its schema describes", async ({ aireg, project, tmp }) => {
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("eng/lint@1.0.0")
    .skill("eng/lint@1.1.0")
    .skill("eng/fmt@1.0.0")
    .write();
  await writeManifestIn(
    project,
    `targets:\n  - claude\nregistries:\n  acme: ${JSON.stringify(market)}\nartifacts: []\n`,
  );
  for (const address of ["acme/eng/skill/lint@1.0.0", "acme/eng/skill/fmt"]) {
    const added = await aireg(["add", address, "-y"]);
    expect(added.code, added.stderr).toBe(0);
  }

  // A pin holding back a newer version is not something to act on, so this exits 0.
  expect(await contract.violations(aireg, ["outdated"], "outdated")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
