import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("targets");

const TOOL = {
  id: "tool",
  displayName: "Tool",
  roots: { project: ".tool", user: { default: "~/.tool", env: "TOOL_HOME" } },
  detect: { binary: ["tool"] },
  reads: { skill: ["universal"] },
  kinds: { agent: { shape: "file", subdir: "agents", extension: ".md" } },
};

test("each targets action prints data its schema describes", async ({ aireg, home, project }) => {
  await writeFile(join(project, "tool.json"), JSON.stringify(TOOL));
  expect(await contract.violations(aireg, ["targets", "check", "tool.json"], "check")).toBe("");

  // A file of yours and one aireg refuses fill `origin` and `skipped`.
  const files = join(home.aireg, "targets");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "tool.json"), JSON.stringify(TOOL));
  await writeFile(join(files, "broken.json"), "{");
  expect(await contract.violations(aireg, ["targets"], "targets")).toBe("");

  // Every built-in, so each shape a kind mapping takes is checked.
  for (const id of [...BUILTIN_TARGETS.map((target) => target.id), "tool"]) {
    expect(await contract.violations(aireg, ["targets", "show", id], "show"), id).toBe("");
  }
  expect(contract.unchecked()).toEqual([]);
});
