import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("install");

test("install prints data its schema describes", async ({ aireg, tmp }) => {
  const kit = await registry(join(tmp, "kit")).skill("kit/lint@1.0.0").write();
  expect((await aireg(["init", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["add", kit, "--all"])).code).toBe(0);

  expect(await contract.violations(aireg, ["install", "--dry-run"], "install")).toBe("");
  expect(await contract.violations(aireg, ["install"], "install")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
