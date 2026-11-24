import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("usage");

test("each usage action prints data its schema describes", async ({ aireg }) => {
  expect(await contract.violations(aireg, ["usage"], "show")).toBe("");
  expect(await contract.violations(aireg, ["usage", "show", "--days", "7"], "show")).toBe("");
  expect(await contract.violations(aireg, ["usage", "share"], "share")).toBe("");
  expect(await contract.violations(aireg, ["usage", "send"], "send")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
