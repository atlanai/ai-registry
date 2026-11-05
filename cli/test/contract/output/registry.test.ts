import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("registry");

const ACME = fileURLToPath(new URL("../../../../examples/acme-registry", import.meta.url));
const SKILLS = fileURLToPath(new URL("../../../../examples/aireg", import.meta.url));

test("each registry action prints data its schema describes", async ({ aireg, tmp }) => {
  const own = join(tmp, "own");
  const init = ["registry", "init", own, "--name", "own", "--namespace", "eng", "-y"];
  expect(await contract.violations(aireg, init, "init")).toBe("");
  expect(await contract.violations(aireg, ["registry", "index", own], "index")).toBe("");
  expect(await contract.violations(aireg, ["registry", "validate", ACME], "validate")).toBe("");

  const add = ["registry", "add", ACME, "--as", "acme"];
  expect(await contract.violations(aireg, add, "add")).toBe("");
  expect(await contract.violations(aireg, ["registry", "list"], "list")).toBe("");
  expect(await contract.violations(aireg, ["registry", "show", "acme"], "show")).toBe("");
  // A folder of skills is not a registry, so its show names the layout it was read as.
  expect(await contract.violations(aireg, ["registry", "show", SKILLS], "show")).toBe("");
  expect(await contract.violations(aireg, ["registry", "remove", "acme"], "remove")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
