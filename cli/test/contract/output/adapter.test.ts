import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("adapter");

test("each adapter action prints data its schema describes", async ({ aireg, home }) => {
  await mkdir(home.aireg, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home.aireg, "config.yml"),
    "schemaVersion: 1\nrevision: 0\nadapters:\n  acme: ./adapters/acme/1.4.0/adapter.mjs\naccounts: []\njobs: []\n",
  );
  expect(await contract.violations(aireg, ["adapter", "list"], "list")).toBe("");
  expect(
    await contract.violations(aireg, ["adapter", "remove", "acme", "--dry-run"], "remove"),
  ).toBe("");
  expect(await contract.violations(aireg, ["adapter", "remove", "acme"], "remove")).toBe("");
  expect(await contract.violations(aireg, ["adapter", "init", "acme", "--dry-run"], "init")).toBe(
    "",
  );
  expect(await contract.violations(aireg, ["adapter", "init", "acme"], "init")).toBe("");
  // Installing needs a release build's signing keys, which no test build carries.
  expect(contract.unchecked()).toEqual(["install"]);
});
