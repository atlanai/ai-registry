import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("status");

test("status prints data its schema describes", async ({ aireg, project, tmp }) => {
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("eng/lint@1.0.0")
    .agent("eng/reviewer@1.0.0", { dependsOn: ["eng/skill/lint@1.0.0"] })
    .write();
  // Gemini CLI loads a project's skills only once trusted, which fills `needsApproval`.
  await writeManifestIn(
    project,
    `targets:\n  - claude\n  - gemini\nregistries:\n  acme: ${JSON.stringify(market)}\nartifacts: []\n`,
  );
  const added = await aireg(["add", "acme/eng/agent/reviewer", "-y"]);
  expect(added.code, added.stderr).toBe(0);
  // Reported without changing the exit status, which stays 0 while every artifact is ok.
  const mine = join(project, ".claude", "skills", "mine");
  await mkdir(mine, { recursive: true });
  await writeFile(join(mine, "SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\n");
  await symlink(join(tmp, "gone"), join(project, ".claude", "skills", "ghost"));

  expect(await contract.violations(aireg, ["status"], "status")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
