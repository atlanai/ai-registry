import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("init");

test("init prints data its schema describes, with and without a registry", async ({
  aireg,
  tmp,
}) => {
  await registry(join(tmp, "acme-registry"), { name: "acme", slug: "acme" })
    .skill("engineering/lint@1.0.0", { description: "Runs the linters." })
    .write();
  expect(await contract.violations(aireg, ["init", "--for", "claude-code"], "init")).toBe("");

  const app = join(tmp, "app");
  await mkdir(app);
  const setUp = ["init", "--registry", "../acme-registry"];
  expect(await contract.violations((args) => aireg(args, { cwd: app }), setUp, "init")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
