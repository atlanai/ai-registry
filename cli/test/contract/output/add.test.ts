import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("add");

test("add prints data its schema describes", async ({ aireg, tmp }) => {
  const kit = await registry(join(tmp, "kit")).skill("kit/lint@1.0.0").write();
  // A folder of skills is not a registry, so its add names the layout.
  const folder = join(tmp, "skills");
  await mkdir(join(folder, "pdf"), { recursive: true });
  await writeFile(
    join(folder, "pdf", "SKILL.md"),
    "---\nname: pdf\ndescription: Read PDFs.\n---\n",
  );
  expect((await aireg(["init", "--for", "claude-code"])).code).toBe(0);

  expect(await contract.violations(aireg, ["add", kit, "--all", "--dry-run"], "add")).toBe("");
  expect(await contract.violations(aireg, ["add", kit, "--all"], "add")).toBe("");
  expect(await contract.violations(aireg, ["add", folder, "--all"], "add")).toBe("");
  // Into the user scope, so a background job keeps it current.
  expect(
    await contract.violations(aireg, ["add", "-g", kit, "--all", "--for", "claude-code"], "add"),
  ).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
