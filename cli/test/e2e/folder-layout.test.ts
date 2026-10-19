import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";
import { makeHome } from "#test/kit/home.ts";
import { runCli } from "#test/kit/run.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

interface Locked {
  registries: Record<string, { revision?: string; config?: Record<string, string> }>;
  artifacts: Record<string, { version?: string; content?: string }>;
}

const lockOf = async (project: string) =>
  parse(await readFile(lockPath(project), "utf8")) as Locked;

const versions = async (project: string) =>
  Object.fromEntries(
    Object.entries((await lockOf(project)).artifacts).map(([name, row]) => [name, row.version]),
  );

/** `pr-review` with a script, `react-tips` filed under `frontend`, `release` and an agent. */
function kit(root: string) {
  return skillsFolder(root)
    .skill("skills/pr-review", { body: "Review it.\n" })
    .file("skills/pr-review/scripts/lint.sh", "#!/bin/sh\necho lint\n", true)
    .skill("skills/frontend/react-tips")
    .skill(".claude/skills/release")
    .agent("agents/reviewer.md")
    .link("skills/evil", "/etc");
}

const init = async (aireg: Aireg) =>
  expect((await aireg(["init", "--for", "claude,codex,cursor,agents"])).code).toBe(0);

describe("a folder of skills on this machine", () => {
  test("installs into every harness, under plain names, and records its layout", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await kit(join(tmp, "skills-repo")).write();
    await init(aireg);
    const added = await aireg(["add", root, "--all"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain("Skipped skills/evil, which is a symlink.");
    for (const path of [
      ".claude/skills/pr-review/SKILL.md",
      ".claude/skills/pr-review/scripts/lint.sh",
      ".agents/skills/react-tips/SKILL.md",
      ".claude/skills/release/SKILL.md",
      ".claude/agents/reviewer.md",
      ".codex/agents/reviewer.toml",
    ]) {
      expect(existsSync(join(project, path)), path).toBe(true);
    }
    const manifest = parse(await readFile(manifestPath(project), "utf8"));
    expect(manifest.registries["skills-repo"]).toMatchObject({ layout: "folder" });
    const lock = await lockOf(project);
    expect(lock.registries["skills-repo"]?.config).toEqual({ layout: "folder" });
    expect(lock.registries["skills-repo"]).not.toHaveProperty("layout");
    expect(await versions(project)).toEqual({
      "pr-review": undefined,
      "react-tips": undefined,
      release: undefined,
      reviewer: undefined,
    });
  }, 60_000);

  test("installs a folder that is one skill, named after the folder", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await skillsFolder(join(tmp, "pdf-tools"))
      .file("SKILL.md", "---\nname: pdf-tools\ndescription: Fill PDFs.\n---\nFill them.\n")
      .file("scripts/fill.sh", "#!/bin/sh\n", true)
      .write();
    await init(aireg);
    const added = await aireg(["add", root, "--all"]);
    expect(added.code, added.stderr).toBe(0);
    expect(existsSync(join(project, ".claude", "skills", "pdf-tools", "scripts", "fill.sh"))).toBe(
      true,
    );
  }, 60_000);

  test("names the layout it read in --json", async ({ aireg, tmp }) => {
    const root = await kit(join(tmp, "skills-repo")).write();
    await init(aireg);
    const added = await aireg(["add", root, "--all", "--json"]);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).data).toMatchObject({
      registry: "skills-repo",
      layout: "folder",
    });
  }, 60_000);

  test("refuses a version, and a publish, naming what to do instead", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await kit(join(tmp, "skills-repo")).write();
    await init(aireg);
    expect((await aireg(["add", root, "--all"])).code).toBe(0);
    const pinned = await aireg(["add", "skills-repo/skills-repo/skill/pr-review@1.0.0", "-y"]);
    expect(pinned.code).toBe(1);
    expect(pinned.stderr).toContain("skills-repo is a folder of skills, which has no versions");
    const published = await aireg([
      "publish",
      join(project, ".claude", "skills", "pr-review"),
      "--to",
      "skills-repo/skills-repo",
      "-y",
    ]);
    expect(published.code).toBe(2);
    expect(published.stderr).toContain(
      "skills-repo is a folder of skills, not a registry, so aireg reads it but does not publish to it.",
    );
    expect(published.stderr).toContain("`aireg registry init <folder>`");
  }, 60_000);

  test("reads what a broken registry.json sits beside only when told to", async ({
    aireg,
    project,
    tmp,
  }) => {
    const root = await kit(join(tmp, "half")).write();
    await writeFile(join(root, "registry.json"), "{ not json");
    await init(aireg);
    const detected = await aireg(["add", root, "--all"]);
    expect(detected.code).toBe(1);
    expect(detected.stderr).toContain("registry.json is not valid JSON.");
    const forced = await aireg(["add", root, "--all", "--layout", "folder", "--as", "half"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await readFile(manifestPath(project), "utf8")).toContain("layout: folder");
  }, 60_000);
});

describe("a git repository of skills", () => {
  test("follows its newest release tag, and moves when a newer one is tagged", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await kit(join(tmp, "skills-repo")).write();
    await git.init(repo);
    const first = await git.commit(repo, "one");
    await git.tag(repo, "v1.0.0");
    await skillsFolder(repo).skill("skills/pr-review", { body: "Review it twice.\n" }).write();
    const second = await git.commit(repo, "two");
    const url = pathToFileURL(repo).href;
    await init(aireg);

    const added = await aireg(["add", url, "--all"]);
    expect(added.code, added.stderr).toBe(0);
    const lock = await lockOf(project);
    expect(lock.registries["skills-repo"]?.revision).toBe(first);
    expect(await versions(project)).toMatchObject({ "pr-review": "1.0.0", reviewer: "1.0.0" });
    expect((await aireg(["outdated"])).code).toBe(0);

    await git.tag(repo, "v1.1.0");
    const outdated = await aireg(["outdated"]);
    expect(outdated.code).toBe(3);
    expect(outdated.stdout).toMatch(/pr-review\s+skills-repo\s+1\.0\.0\s+1\.1\.0/);
    const updated = await aireg(["update", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect((await lockOf(project)).registries["skills-repo"]?.revision).toBe(second);
    expect(await versions(project)).toMatchObject({ "pr-review": "1.1.0", reviewer: "1.1.0" });
  }, 60_000);

  test("reads a branch at a pseudo-version, which pins its commit", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await kit(join(tmp, "skills-repo")).write();
    await git.init(repo);
    await git.commit(repo, "one");
    await git.tag(repo, "v1.0.0");
    await skillsFolder(repo).skill("skills/pr-review", { body: "Review it twice.\n" }).write();
    const second = await git.commit(repo, "two");
    const url = pathToFileURL(repo).href;
    await init(aireg);

    const added = await aireg(["add", url, "-s", "pr-review", "--ref", "main"]);
    expect(added.code, added.stderr).toBe(0);
    const pseudo = (await versions(project))["pr-review"] as string;
    expect(pseudo).toMatch(new RegExp(`^1\\.0\\.1-0\\.\\d{14}-${second.slice(0, 12)}$`));

    // Pinned by its pseudo-version, the commit holds after the branch moves on.
    expect(
      (await aireg(["add", `skills-repo/skills-repo/skill/pr-review@${pseudo}`, "-y"])).code,
    ).toBe(0);
    await skillsFolder(repo)
      .skill("skills/pr-review", { body: "Review it three times.\n" })
      .write();
    await git.commit(repo, "three");
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect((await versions(project))["pr-review"]).toBe(pseudo);
  }, 60_000);

  test("installs exactly what the lockfile holds in a fresh home, with --frozen", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await kit(join(tmp, "skills-repo")).write();
    await git.init(repo);
    await git.commit(repo, "one");
    await git.tag(repo, "v1.0.0");
    await init(aireg);
    expect((await aireg(["add", pathToFileURL(repo).href, "--all", "--ref", "main"])).code).toBe(0);
    // The branch moves on; the lockfile does not.
    await skillsFolder(repo).skill("skills/pr-review", { body: "Changed.\n" }).write();
    await git.commit(repo, "two");

    const clone = join(tmp, "clone");
    await cp(join(project, ".registry"), join(clone, ".registry"), { recursive: true });
    const fresh = await makeHome(join(tmp, "fresh-home"));
    const installed = await runCli(["install", "--frozen"], {
      cwd: clone,
      home: fresh.dir,
      env: fresh.env,
      node: [],
    });
    expect(installed.code, installed.stderr).toBe(0);
    expect(await readFile(lockPath(clone), "utf8")).toBe(await readFile(lockPath(project), "utf8"));
    expect(
      await readFile(join(clone, ".claude", "skills", "pr-review", "SKILL.md"), "utf8"),
    ).toContain("Review it.");
  }, 60_000);
});
