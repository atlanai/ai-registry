import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("doctor");

test("doctor prints data its schema describes", async ({ aireg }) => {
  expect(await contract.violations(aireg, ["doctor"], "doctor")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
