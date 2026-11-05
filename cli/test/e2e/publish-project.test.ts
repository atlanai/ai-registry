import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { fileTest as test } from "#test/kit/fixtures.ts";
import { exec } from "#test/kit/run.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

let root: string;

test.beforeAll(({ tmp }) => {
  root = tmp;
});

describe("publishing from a project", () => {
  test("refuses a git registry, and writes into a clone of it named by path", async ({
    aireg,
    git,
    home,
  }) => {
    const scratch = join(root, "push-new");
    const mp = join(root, "push-new-repo");
    const clone = join(root, "push-new-clone");
    await registry(mp).skill("acme/seed@1.0.0", { description: "s", body: "body\n" }).write();
    await git.init(mp);
    await git.commit(mp, "initial");
    await git(root, "clone", "-q", mp, clone);

    await mkdir(join(scratch, ".claude", "agents"), { recursive: true });
    await writeManifestIn(
      scratch,
      [
        "registries:",
        "  kit:",
        `    source: file://${mp}`,
        "artifacts:",
        "  - kit/acme/skill/seed",
      ].join("\n"),
    );
    expect((await aireg(["install"], { cwd: scratch })).code).toBe(0);
    await writeFile(
      join(scratch, ".claude", "agents", "hotfix.md"),
      "---\ndescription: Cut a hotfix.\n---\nBranch from the tag.\n",
    );

    const hotfix = join(".claude", "agents", "hotfix.md");
    const refused = await aireg(["publish", hotfix, "--to", "kit/mine", "--yes"], {
      cwd: scratch,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/kit is a git registry, and aireg does not publish to git/);
    // With nowhere named and only kit declared, it says so before asking anything.
    const unnamed = await aireg(["publish", hotfix, "--yes"], { cwd: scratch });
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toMatch(/kit is a git registry, and aireg does not publish to git/);

    const published = await aireg(["publish", hotfix, "--to", join(clone, "mine"), "--yes"], {
      cwd: scratch,
    });
    expect(published.code, published.stderr).toBe(0);
    const next = /next\s+(.+)$/m.exec(published.stdout)?.[1];
    expect(next).toBe(
      'cd ../push-new-clone && git add . && git commit -m "add hotfix 0.1.0" && git push',
    );
    // The clone's origin has its branch checked out, so everything but the push runs here.
    const commit = (next as string).replace(/ && git push$/, "");
    await exec("sh", ["-c", commit], { cwd: scratch, env: { ...process.env, ...home.env } });
    expect(await git(clone, "status", "--porcelain")).toBe("");
    expect(published.stdout).not.toContain("your user scope");
    // A publish adds a version directory with the envelope beside the native file.
    const at = (path: string) => readFile(join(clone, path), "utf8");
    // An agent goes in as AGENT.md, named and otherwise as written.
    const agent = await at("artifacts/mine/agent/hotfix/0.1.0/AGENT.md");
    expect(agent).toBe(
      "---\ndescription: Cut a hotfix.\nname: hotfix\n---\nBranch from the tag.\n",
    );
    expect(await at("artifacts/mine/agent/hotfix/0.1.0/artifact.json")).toContain(
      '"namespace": "mine"',
    );
    expect(await at("index.json")).toContain("hotfix");
    const again = await aireg(["publish", hotfix, "--to", join(clone, "mine"), "--yes"], {
      cwd: scratch,
    });
    expect(again.stdout).toMatch(/Nothing new to publish/);

    // The registry is named as --to gave it, whatever folder aireg runs from.
    const rollback = join(".claude", "agents", "rollback.md");
    await writeFile(join(scratch, rollback), "---\ndescription: Roll back.\n---\nRevert it.\n");
    for (const [to, named] of [
      [join(clone, "mine"), clone],
      [join(relative(scratch, clone), "mine"), relative(scratch, clone)],
    ] as const) {
      const planned = await aireg(
        ["publish", rollback, "--to", to, "--dry-run", "--yes", "--json"],
        { cwd: scratch },
      );
      expect(planned.code, planned.stderr).toBe(0);
      expect(JSON.parse(planned.stdout).data.artifacts[0].registry).toBe(named);
    }
  });

  test("keeps a copy sent with --force into a clone, and warns before update replaces it", async ({
    aireg,
    git,
  }) => {
    const scratch = join(root, "force-clone");
    const mp = join(root, "force-clone-repo");
    const clone = join(root, "force-clone-clone");
    const seed = registry(mp).skill("acme/seed@1.0.0", { body: "body\n" });
    await seed.write();
    await git.init(mp);
    await git.commit(mp, "initial");
    await git(root, "clone", "-q", mp, clone);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await writeManifestIn(
      scratch,
      `registries:\n  kit:\n    source: file://${mp}\nartifacts:\n  - kit/acme/skill/seed`,
    );
    expect((await aireg(["install"], { cwd: scratch })).code).toBe(0);
    // A teammate releases 1.0.1 after this copy was installed, and the clone pulls it.
    await seed.skill("acme/seed@1.0.1", { body: "theirs\n" }).write();
    await git.commit(mp, "seed 1.0.1");
    await git(clone, "pull", "-q");
    const copy = join(scratch, ".claude", "skills", "seed", "SKILL.md");
    await appendFile(copy, "Mine.\n");

    const sent = await aireg(["publish", "seed", "--to", join(clone, "acme"), "--yes", "--force"], {
      cwd: scratch,
    });
    expect(sent.code, sent.stderr).toBe(0);
    expect(await readFile(copy, "utf8")).toContain("Mine.");
    expect(sent.stderr).toMatch(/serves seed 1\.0\.1, not the 1\.0\.2 you published/);
  });

  // Last, because the namespace default it sets is your own and every publish after reads it.
  test("refuses new work with no destination or an undeclared one, and takes your default namespace", async ({
    aireg,
    git,
  }) => {
    const repo = await gitRegistry(git, join(root, "push-to-kit"));
    const scratch = join(root, "push-to");
    const second = await registry(join(root, "push-to-second"))
      .skill("acme/other@1.0.0", { description: "o", body: "body\n" })
      .write();
    const at = { cwd: scratch };

    await mkdir(join(scratch, ".claude", "skills", "mine"), { recursive: true });
    await writeManifestIn(
      scratch,
      [
        "registries:",
        "  kit:",
        `    source: file://${repo}`,
        "  other:",
        `    source: ${second}`,
        "artifacts:",
        "  - kit/skill/lint",
      ].join("\n"),
    );
    expect((await aireg(["install"], at)).code).toBe(0);
    await writeFile(
      join(scratch, ".claude", "skills", "mine", "SKILL.md"),
      "---\nname: mine\ndescription: written here\n---\nlocal\n",
    );

    const mine = join(".claude", "skills", "mine");
    const nowhere = await aireg(["publish", mine, "--yes"], at);
    expect(nowhere.code).toBe(2);
    expect(nowhere.stderr).toMatch(/--to <registry>\/<namespace>/);

    const wrong = await aireg(["publish", mine, "--yes", "--to", "nope/acme"], at);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/No registry named/);

    const chosen = await aireg(["publish", mine, "--yes", "--to", "other/acme"], at);
    expect(chosen.code, chosen.stderr).toBe(0);
    expect(
      await readFile(join(second, "artifacts/acme/skill/mine/0.1.0/SKILL.md"), "utf8"),
    ).toContain("local");
    // Where new work goes is your own default, never written into the project's manifest.
    expect(await readFile(join(scratch, ".registry", "manifest.yml"), "utf8")).not.toMatch(
      /^publish:/m,
    );

    await mkdir(join(scratch, ".claude", "skills", "more"), { recursive: true });
    await writeFile(
      join(scratch, ".claude", "skills", "more", "SKILL.md"),
      "---\nname: more\ndescription: written here\n---\nmore\n",
    );
    expect((await aireg(["config", "set", "defaults.namespace", "other/acme"], at)).code).toBe(0);
    const defaulted = await aireg(["publish", join(".claude", "skills", "more"), "--yes"], at);
    expect(defaulted.code, defaulted.stderr).toBe(0);
    expect(
      await readFile(join(second, "artifacts/acme/skill/more/0.1.0/SKILL.md"), "utf8"),
    ).toContain("more");
    // A default for a registry this project does not declare belongs to other projects.
    expect((await aireg(["config", "set", "defaults.namespace", "nope/acme"], at)).code).toBe(0);
    await mkdir(join(scratch, ".claude", "skills", "third"), { recursive: true });
    await writeFile(
      join(scratch, ".claude", "skills", "third", "SKILL.md"),
      "---\nname: third\ndescription: written here\n---\nthird\n",
    );
    const homeless = await aireg(["publish", join(".claude", "skills", "third"), "--yes"], at);
    expect(homeless.code).toBe(2);
    expect(homeless.stderr).toMatch(/--to <registry>\/<namespace>/);
  });
});
