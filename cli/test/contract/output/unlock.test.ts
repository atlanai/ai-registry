import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { leaseKey } from "#core/lease/location.ts";
import { test } from "#test/kit/fixtures.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("unlock");

test("unlock prints data its schema describes, held, free and cleared", async ({
  aireg,
  project,
}) => {
  await writeManifestIn(project, "targets:\n  - claude\nregistries: {}\nartifacts: []\n");
  expect(await contract.violations(aireg, ["unlock"], "unlock")).toBe("");

  // A holder no process answers for, as a writer that died leaves behind.
  const lease = join(
    project,
    ".registry",
    "leases",
    `${leaseKey({ lock: lockPath(project) })}.lease`,
  );
  await mkdir(lease, { recursive: true });
  await writeFile(
    join(lease, "meta.json"),
    JSON.stringify({
      id: "held",
      scope: "project",
      lock: "",
      host: "",
      pid: 4242,
      acquiredAtMs: 0,
    }),
  );
  expect(await contract.violations(aireg, ["unlock"], "unlock")).toBe("");
  expect(await contract.violations(aireg, ["unlock", "held"], "unlock")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
