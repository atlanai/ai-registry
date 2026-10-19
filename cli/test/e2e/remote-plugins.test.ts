import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { type Git, test } from "#test/kit/fixtures.ts";
import { makeHome } from "#test/kit/home.ts";
import { runCli } from "#test/kit/run.ts";
import { lockPath } from "#test/kit/scope.ts";

/** A repository holding one plugin, `far`, with two commits: `first` and `second`. */
async function pluginRepo(git: Git, root: string, folder = "") {
  const at = (path: string) => (folder === "" ? path : `${folder}/${path}`);
  await skillsFolder(root)
    .json(at(".claude-plugin/plugin.json"), { name: "far" })
    .skill(at("skills/far"), { body: "First.\n" })
    .write();
  await git.init(root);
  const first = await git.commit(root, "one");
  await skillsFolder(root).skill(at("skills/far"), { body: "Second.\n" }).write();
  const second = await git.commit(root, "two");
  return { first, second, url: pathToFileURL(root).href };
}

/** A git marketplace listing one plugin by `source`. */
async function marketplaceRepo(git: Git, root: string, source: unknown) {
  await skillsFolder(root)
    .json(".claude-plugin/marketplace.json", {
      name: "acme-tools",
      owner: { name: "Acme" },
      plugins: [{ name: "far", source }],
    })
    .write();
  await git.init(root);
  await git.commit(root, "marketplace");
  return pathToFileURL(root).href;
}

interface Row {
  revision?: string;
  version?: string;
}

const row = async (project: string) =>
  (parse(await readFile(lockPath(project), "utf8")) as { artifacts: Record<string, Row> }).artifacts
    .far;

const installed = (project: string) =>
  readFile(join(project, ".claude", "skills", "far", "skills", "far", "SKILL.md"), "utf8");

describe("a marketplace plugin fetched from another repository", () => {
  test("is read at its sha, which wins over its ref, and keeps that commit", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const plugin = await pluginRepo(git, join(tmp, "far"));
    const mkt = await marketplaceRepo(git, join(tmp, "mkt"), {
      source: "url",
      url: plugin.url,
      ref: "main",
      sha: plugin.first,
    });
    expect((await aireg(["init", "--for", "claude"])).code).toBe(0);
    const added = await aireg(["add", mkt, "--all"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await installed(project)).toContain("First.");
    expect((await row(project))?.revision).toBe(plugin.first);
  }, 60_000);

  test("follows its ref, holds the commit the lockfile records, and moves on update", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const root = join(tmp, "monorepo");
    const plugin = await pluginRepo(git, root, "tools/far");
    const mkt = await marketplaceRepo(git, join(tmp, "mkt"), {
      source: "git-subdir",
      url: plugin.url,
      path: "tools/far",
    });
    expect((await aireg(["init", "--for", "claude"])).code).toBe(0);
    expect((await aireg(["add", mkt, "--all"])).code).toBe(0);
    expect((await row(project))?.revision).toBe(plugin.second);

    await skillsFolder(root).skill("tools/far/skills/far", { body: "Third.\n" }).write();
    const third = await git.commit(root, "three");

    // A fresh clone of the project, in a fresh home, installs the commit the lockfile holds.
    const clone = join(tmp, "clone");
    await cp(join(project, ".registry"), join(clone, ".registry"), { recursive: true });
    const fresh = await makeHome(join(tmp, "fresh"));
    const frozen = await runCli(["install", "--frozen"], {
      cwd: clone,
      home: fresh.dir,
      env: fresh.env,
      node: [],
    });
    expect(frozen.code, frozen.stderr).toBe(0);
    expect(
      await readFile(join(clone, ".claude", "skills", "far", "skills", "far", "SKILL.md"), "utf8"),
    ).toContain("Second.");

    expect((await aireg(["install"])).code).toBe(0);
    expect((await row(project))?.revision).toBe(plugin.second);
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect((await row(project))?.revision).toBe(third);
    expect(await installed(project)).toContain("Third.");
  }, 60_000);

  test("refuses a sha that is not a full commit", async ({ aireg, git, tmp }) => {
    const plugin = await pluginRepo(git, join(tmp, "far"));
    const mkt = await marketplaceRepo(git, join(tmp, "mkt"), {
      source: "url",
      url: plugin.url,
      sha: plugin.first.slice(0, 12),
    });
    expect((await aireg(["init", "--for", "claude"])).code).toBe(0);
    const added = await aireg(["add", mkt, "--all"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      "which is not a full commit: it takes 40 lowercase hex characters.",
    );
  }, 60_000);

  test("never runs a command source, and skips npm and archive ones", async ({
    aireg,
    git,
    tmp,
  }) => {
    const marker = join(tmp, "ran");
    const root = join(tmp, "mkt");
    await skillsFolder(root)
      .json(".claude-plugin/marketplace.json", {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: [
          { name: "made", source: { source: "command", command: `touch ${marker}` } },
          { name: "pkg", source: { source: "npm", package: "@example/pkg" } },
          { name: "zip", source: { source: "archive", url: "https://example.test/zip.zip" } },
          { name: "here", source: "./here" },
        ],
      })
      .skill("here/skills/hello")
      .write();
    await git.init(root);
    await git.commit(root, "marketplace");
    expect((await aireg(["init", "--for", "claude"])).code).toBe(0);
    const shown = await aireg(["registry", "show", pathToFileURL(root).href]);
    expect(shown.code, shown.stderr).toBe(0);
    for (const [name, type] of [
      ["made", "command"],
      ["pkg", "npm"],
      ["zip", "archive"],
    ]) {
      expect(shown.stderr).toContain(
        `Skipped "${name}": its ${type} source is not one aireg reads.`,
      );
    }
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});
