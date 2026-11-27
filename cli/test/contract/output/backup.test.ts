import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("backup");

test("each backup action prints data its schema describes", async ({ aireg, home }) => {
  expect(await contract.violations(aireg, ["backup", "list", "-g"], "list")).toBe("");
  const run = join(home.scope, "backups", "20261019T000000Z");
  for (const name of ["lint", "review"]) {
    await mkdir(join(run, "claude-code", "skills", name), { recursive: true });
    await writeFile(join(run, "claude-code", "skills", name, "SKILL.md"), `${name}\n`);
  }
  await mkdir(join(run, "gone", "skills", "old"), { recursive: true });
  await mkdir(join(home.dir, ".claude", "skills", "review"), { recursive: true });
  expect(await contract.violations(aireg, ["backup", "list", "-g"], "list")).toBe("");
  const restore = ["backup", "restore", "20261019T000000Z", "-g"];
  expect(await contract.violations(aireg, restore, "restore")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
