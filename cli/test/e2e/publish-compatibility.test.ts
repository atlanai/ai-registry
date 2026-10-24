import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

test("publishes an explicitly named AGENT.md without its companion files", async ({
  aireg,
  git,
  project,
}) => {
  await git.init(project);
  await writeManifestIn(project, "registries: {}\nartifacts: []\n");
  const agent = join(project, "reviewer");
  await mkdir(agent);
  const body = "---\nname: reviewer\ndescription: Reviews code.\n---\nReview it.\n";
  await writeFile(join(agent, "AGENT.md"), body);
  await writeFile(join(agent, "companion.txt"), "Keep this local.\n");
  const made = await aireg(["registry", "init", "registry", "--name", "fixture", "-y"]);
  expect(made.code, made.stderr).toBe(0);
  const sent = await aireg([
    "publish",
    "reviewer/AGENT.md",
    "--to",
    "./registry/engineering",
    "-y",
  ]);
  expect(sent.code, sent.stderr).toBe(0);
  const stored = join(project, "registry/artifacts/engineering/agent/reviewer/0.1.0");
  const envelope = JSON.parse(await readFile(join(stored, "artifact.json"), "utf8"));
  expect(envelope.files.map(({ path }: { path: string }) => path)).toEqual(["AGENT.md"]);
  expect(await readFile(join(stored, "AGENT.md"), "utf8")).toBe(body);
  await expect(readFile(join(stored, "companion.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("publishes an existing skill with AGENT.md as a companion file", async ({
  aireg,
  git,
  project,
}) => {
  await git.init(project);
  await writeManifestIn(project, "registries: {}\nartifacts: []\n");
  const skill = join(project, "review");
  await mkdir(skill);
  const body = skillBody("review", "Reviews code.", "Review it.\n");
  await writeFile(join(skill, "SKILL.md"), body);
  await writeFile(join(skill, "AGENT.md"), "Companion guidance.\n");
  const made = await aireg(["registry", "init", "registry", "--name", "fixture", "-y"]);
  expect(made.code, made.stderr).toBe(0);
  const sent = await aireg(["publish", "review", "--to", "./registry/engineering", "-y"]);
  expect(sent.code, sent.stderr).toBe(0);
  const stored = join(project, "registry/artifacts/engineering/skill/review/0.1.0");
  const envelope = JSON.parse(await readFile(join(stored, "artifact.json"), "utf8"));
  expect(envelope.files.map(({ path }: { path: string }) => path).sort()).toEqual([
    "AGENT.md",
    "SKILL.md",
  ]);
  expect(await readFile(join(stored, "SKILL.md"), "utf8")).toBe(body);
  expect(await readFile(join(stored, "AGENT.md"), "utf8")).toBe("Companion guidance.\n");
});
