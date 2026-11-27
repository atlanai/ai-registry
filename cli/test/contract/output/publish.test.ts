import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("publish");

// An agent with companion files and a dependency, an export kept back, and a blocked version
// fill every optional key.
const MANIFEST = `exports:
  - skills
  - path: skills/draft
    publish: false
  - path: agents/helper
    depends_on: [./skills/review]
publish:
  to: ./registry/team
`;

async function write(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

test("publish prints data its schema describes, sent, planned and kept back", async ({
  aireg,
  project,
  git,
}) => {
  await git.init(project);
  await write(join(project, "skills", "review", "SKILL.md"), skillBody("review"));
  await write(join(project, "skills", "draft", "SKILL.md"), skillBody("draft"));
  const agent = join(project, "agents", "helper");
  await write(join(agent, "AGENT.md"), "---\nname: helper\ndescription: Helps.\n---\nHelp.\n");
  await write(join(agent, "notes", "STYLE.md"), "Be brief.\n");
  await writeManifestIn(project, MANIFEST);
  await git.commit(project);
  const made = await aireg(["registry", "init", "registry", "--name", "team", "-y"]);
  expect(made.code, made.stderr).toBe(0);

  expect(await contract.violations(aireg, ["publish", "-y"], "publish")).toBe("");
  await write(join(agent, "notes", "STYLE.md"), "Be briefer.\n");
  await write(join(project, "skills", "review", "SKILL.md"), skillBody("review", "Reviews."));
  await git.commit(project);
  expect(await contract.violations(aireg, ["publish", "--dry-run"], "publish")).toBe("");
  const kept = ["publish", "skills/draft", "--dry-run"];
  expect(await contract.violations(aireg, kept, "publish")).toBe("");
  const versions = join(project, "registry/artifacts/team/skill/review/versions.json");
  const document = JSON.parse(await readFile(versions, "utf8")) as {
    versions: { status?: string; reason?: string }[];
  };
  for (const row of document.versions) Object.assign(row, { status: "blocked", reason: "unsafe" });
  await writeFile(versions, JSON.stringify(document));
  expect(await contract.violations(aireg, ["publish", "--dry-run"], "publish")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
