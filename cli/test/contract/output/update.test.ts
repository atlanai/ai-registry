import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("update");

test("update prints data its schema describes", async ({ aireg, tmp }) => {
  const kit = registry(join(tmp, "kit")).skill("kit/lint@1.0.0");
  const at = await kit.write();
  expect((await aireg(["init", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["add", at, "--all"])).code).toBe(0);
  await kit.skill("kit/lint@1.1.0").write();

  expect(await contract.violations(aireg, ["update", "--dry-run"], "update")).toBe("");
  expect(await contract.violations(aireg, ["update"], "update")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
