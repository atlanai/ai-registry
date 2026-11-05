import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("sync");

test("sync, its dry run and resolve print data their schema describes", async ({
  aireg,
  project,
  tmp,
}) => {
  const reg = join(tmp, "reg");
  const maker = join(tmp, "maker");
  const skill = join(maker, "lint", "SKILL.md");
  // Each publish from the maker moves the registry's copy past what the project holds.
  const publish = async (extra: string) => {
    await writeFile(skill, skillBody("lint", "Lints.", extra));
    const sent = await aireg(["publish", "lint", "--to", `${reg}/team`, "-y"], { cwd: maker });
    expect(sent.code, sent.stderr).toBe(0);
  };
  await mkdir(join(maker, "lint"), { recursive: true });
  expect((await aireg(["registry", "init", reg, "--name", "team", "-y"])).code).toBe(0);
  await publish("One.\n");
  expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["registry", "add", reg])).code).toBe(0);
  const added = await aireg(["add", "team/team/skill/lint", "-y"]);
  expect(added.code, added.stderr).toBe(0);

  expect(await contract.violations(aireg, ["sync", "--dry-run"], "sync")).toBe("");
  await publish("Two.\n");
  expect(await contract.violations(aireg, ["sync"], "sync")).toBe("");

  await appendFile(join(project, ".claude", "skills", "lint", "SKILL.md"), "Mine.\n");
  await publish("Three.\n");
  expect((await aireg(["sync"])).code).toBe(3);
  const theirs = ["sync", "resolve", "lint", "--theirs"];
  expect(await contract.violations(aireg, theirs, "resolve")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
