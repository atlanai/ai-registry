import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("search");

const ACME = fileURLToPath(new URL("../../../../examples/acme-registry", import.meta.url));

test("search prints matches its schema describes", async ({ aireg }) => {
  expect((await aireg(["registry", "add", ACME, "--as", "acme"])).code).toBe(0);
  expect(await contract.violations(aireg, ["search", "review"], "search")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
