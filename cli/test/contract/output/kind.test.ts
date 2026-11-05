import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("kind");

test("each kind action prints data its schema describes", async ({ aireg, tmp }) => {
  expect(await contract.violations(aireg, ["skill", "new", "probe"], "new")).toBe("");

  const created = await aireg(
    ["registry", "init", "reg", "--name", "acme", "--namespace", "eng", "-y"],
    {
      cwd: tmp,
    },
  );
  expect(created.code, created.stderr).toBe(0);
  const inRegistry = (args: readonly string[]) => aireg(args, { cwd: join(tmp, "reg") });
  const named = ["--namespace", "eng"];
  expect(await contract.violations(inRegistry, ["skill", "new", "ship", ...named], "new")).toBe("");
  expect(await contract.violations(inRegistry, ["agent", "new", "plan", ...named], "new")).toBe("");
  expect(await contract.violations(inRegistry, ["skill", "bump", "ship", ...named], "bump")).toBe(
    "",
  );

  const source = join(tmp, "hello");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "---\nname: hello\ndescription: Say hello.\n---\n");
  const from = ["skill", "new", "--from", source, ...named];
  expect(await contract.violations(inRegistry, from, "new")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
