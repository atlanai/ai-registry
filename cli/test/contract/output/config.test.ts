import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("config");

test("each config action prints data its schema describes", async ({ aireg }) => {
  expect(await contract.violations(aireg, ["config", "list"], "list")).toBe("");
  expect(await contract.violations(aireg, ["config", "path"], "path")).toBe("");
  expect(await contract.violations(aireg, ["config", "set", "paused", "true"], "set")).toBe("");
  expect(await contract.violations(aireg, ["config", "get", "paused"], "get")).toBe("");
  expect(await contract.violations(aireg, ["config", "unset", "paused"], "unset")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
