import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("watch");

test("each watch action prints data its schema describes", async ({ aireg, home, tmp }) => {
  expect(await contract.violations(aireg, ["watch", "list"], "list")).toBe("");
  const made = await aireg(["registry", "init", join(tmp, "reg"), "--name", "team", "-y"]);
  expect(made.code, made.stderr).toBe(0);
  expect((await aireg(["registry", "add", join(tmp, "reg"), "-g"])).code).toBe(0);
  const skills = join(home.dir, ".claude", "skills");
  await mkdir(join(skills, "notes"), { recursive: true });
  await writeFile(join(skills, "notes", "SKILL.md"), skillBody("notes"));
  const add = ["watch", "add", skills, "--to", "team/personal", "-g"];
  expect(await contract.violations(aireg, add, "add")).toBe("");

  expect(await contract.violations(aireg, ["watch", "list"], "list")).toBe("");
  expect(await contract.violations(aireg, ["watch", "remove", skills, "-g"], "remove")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
