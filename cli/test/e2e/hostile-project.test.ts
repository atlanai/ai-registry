import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

// A cloned project brings its own `.claude/skills` link and `.registry` folder.
test("removes nothing outside a cloned project that ships a harness link and a journal", async ({
  aireg,
  tmp,
}) => {
  const root = await realpath(tmp);
  const project = join(root, "work", "project");
  const victim = join(root, "work", "victim");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(victim, { recursive: true });
  await writeFile(join(victim, "keep"), "canary\n");
  await symlink("../..", join(project, ".claude", "skills"));
  await writeManifestIn(project, "artifacts: []\n");
  await writeFile(
    join(project, ".registry", "apply-journal.json"),
    JSON.stringify({ writes: ["../victim", join(project, ".claude", "skills", "victim")] }),
  );

  const ran = await aireg(["install", "--json"], { cwd: project });

  expect(ran.code, ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout).ok).toBe(true);
  expect(await readFile(join(victim, "keep"), "utf8")).toBe("canary\n");
});

// Every other scope write refuses a committed `.registry` link; the manifest and leases must too.
test("writes no manifest or lease through a .registry link out of the project", async ({
  aireg,
  tmp,
}) => {
  const root = await realpath(tmp);
  const market = join(root, "market");
  await registry(market, { name: "acme", slug: "acme" }).skill("eng/lint@1.0.0").write();
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  await mkdir(project, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const declared = `registries:\n  acme: ${market}\nartifacts: []\n`;
  await writeFile(join(elsewhere, "manifest.yml"), declared);
  await symlink("../elsewhere", join(project, ".registry"));

  for (const argv of [
    ["init", "--for", "claude", "--force"],
    ["registry", "add", market, "--as", "acme"],
    ["add", "acme/eng", "-y"],
  ]) {
    const ran = await aireg(argv, { cwd: project });
    expect(ran.code, argv.join(" ")).not.toBe(0);
    expect(ran.stderr, argv.join(" ")).toContain("is a symlink in a managed path");
  }
  expect(await readdir(elsewhere)).toEqual(["manifest.yml"]);
  expect(await readFile(join(elsewhere, "manifest.yml"), "utf8")).toBe(declared);
});

// Legal artifact names that are also members of every JavaScript object.
test("installs, lists and removes artifacts named constructor and prototype", async ({
  aireg,
  tmp,
}) => {
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("eng/constructor@1.0.0")
    .skill("eng/prototype@1.0.0")
    .write();
  await aireg(["init", "--for", "claude"]);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  const added = await aireg(["add", "acme/eng", "-y"]);
  expect(added.code, added.stderr).toBe(0);
  const listed = await aireg(["list"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout).toMatch(/constructor[\s\S]*prototype/);
  expect((await aireg(["install", "--frozen"])).code).toBe(0);
  const removed = await aireg(["remove", "constructor", "-y"]);
  expect(removed.code, removed.stderr).toBe(0);
  expect((await aireg(["list"])).stdout).not.toContain("constructor");
});

// A mistyped address can carry a password, and CI logs keep whatever is printed.
test("lists a declared address without its userinfo", async ({ aireg, project }) => {
  await mkdir(join(project, ".registry"), { recursive: true });
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    "registries:\n  acme: https://user:synthetic-pass@example.invalid/acme.git\n",
  );
  for (const argv of [
    ["registry", "list"],
    ["registry", "list", "--json"],
  ]) {
    const ran = await aireg(argv);
    expect(ran.code, argv.join(" ")).toBe(0);
    expect(ran.stdout, argv.join(" ")).toContain("https://<redacted>@example.invalid/acme.git");
    expect(ran.stdout + ran.stderr, argv.join(" ")).not.toContain("synthetic-pass");
  }
});

test("refuses a GitHub URL whose derived name the cloned project declares elsewhere", async ({
  aireg,
  tmp,
}) => {
  const root = await realpath(tmp);
  const project = join(root, "project");
  await registry(join(project, "evil"), { name: "evil", slug: "evil" })
    .skill("team/helper@1.0.0")
    .write();
  const declared = "registries:\n  repo: ./evil\nartifacts: []\n";
  await writeManifestIn(project, declared);

  const ran = await aireg(["add", "github.com/trusted-org/repo/team/helper", "--yes", "--json"], {
    cwd: project,
  });

  expect(ran.code).not.toBe(0);
  expect(JSON.parse(ran.stdout).error).toMatchObject({
    code: "usage",
    message: `The name "repo" is already taken by ${join(project, "evil")}.`,
  });
  expect(await readdir(join(project, ".registry"))).toEqual(["manifest.yml"]);
  expect(await readFile(join(project, ".registry", "manifest.yml"), "utf8")).toBe(declared);
});
