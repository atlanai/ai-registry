import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("logs");

test("logs prints records its schema describes", async ({ aireg }) => {
  // A command run at debug writes records, so the entries hold real ones.
  await aireg(["config", "list", "--log-level", "debug"]);
  expect(await contract.violations(aireg, ["logs", "--cli"], "logs")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
