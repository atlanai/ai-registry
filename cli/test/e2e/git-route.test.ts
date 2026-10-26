import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { fileTest } from "#test/kit/fixtures.ts";
import { makeHome } from "#test/kit/home.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";
import { projected, TARGET_ROOTS } from "#test/kit/target.ts";

const test = fileTest.extend("repo", { scope: "file" }, ({ git, tmp }) =>
  gitRegistry(git, join(tmp, "kit")),
);

describe("the git route, end to end", () => {
  test("installs, links and locks", async ({ aireg, project, repo }) => {
    await mkdir(join(project, ".claude"), { recursive: true });
    const started = await aireg(["init"]);
    expect(started.code, started.stderr).toBe(0);
    // No --for: the manifest's `targets:` governs, so add and sync agree.
    const added = await aireg(["add", `file://${repo}@v1`]);
    expect(added.code, added.stderr).toBe(0);

    const skill = await readFile(projected(project, "lint"), "utf8");
    expect(skill).toContain("run");

    const lock = await readFile(lockPath(project), "utf8");
    expect(lock).toContain("adapter: git");
    expect(lock).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("is idempotent and byte-identical", async ({ aireg, project }) => {
    const before = await readFile(lockPath(project), "utf8");
    const resynced = await aireg(["install"]);
    expect(resynced.code, resynced.stderr).toBe(0);
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
  });

  test("reports an edit and exits 3, then repairs under --force", async ({ aireg, project }) => {
    // Edited where a person edits it: through the target's folder, which links into
    // the plugin, which links into the mirror.
    await writeFile(projected(project, "lint"), "edited", "utf8");

    const edited = await aireg(["status"]);
    expect(edited.code).toBe(3);
    expect(edited.stdout).toMatch(/edited/);

    await aireg(["install"]);
    expect((await aireg(["status"])).code).toBe(3);

    await aireg(["install", "--force"]);
    expect((await aireg(["status"])).code).toBe(0);
  });

  test("removes only what it recorded, and an edit only when forced", async ({
    aireg,
    project,
  }) => {
    await writeFile(join(project, ".claude", "skills", "handwritten.md"), "mine", "utf8");
    const staged = projected(project, "lint");
    await writeFile(staged, "edited", "utf8");
    const refused = await aireg(["remove", "acme/lint"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/has local edits/);
    expect(await readFile(staged, "utf8")).toBe("edited");

    const removed = await aireg(["remove", "acme/lint", "--force"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(await readFile(join(project, ".claude", "skills", "handwritten.md"), "utf8")).toBe(
      "mine",
    );
  });

  test("leaves alone the repository of a git hook it runs in", async ({
    aireg,
    git,
    tmp,
    repo,
  }) => {
    const hooked = join(tmp, "hooked");
    await git.init(hooked);
    await writeFile(join(hooked, "app.txt"), "app\n", "utf8");
    const head = await git.commit(hooked, "app");

    // What git exports to a pre-commit hook; the cold cache makes aireg clone.
    const cold = await makeHome(join(tmp, "cold-home"));
    const added = await aireg(["add", `file://${repo}@v1`, "--for", "claude-code"], {
      cwd: hooked,
      env: {
        ...cold.env,
        GIT_DIR: join(hooked, ".git"),
        GIT_INDEX_FILE: join(hooked, ".git", "index"),
      },
    });
    expect(added.code, added.stderr).toBe(0);
    expect(await git(hooked, "rev-parse", "HEAD")).toBe(head);
    expect(await git(hooked, "remote")).toBe("");
    expect(await git(hooked, "diff", "--cached", "--name-only")).toBe("");
  });

  test("warns when the same artifact is installed at two scopes", async ({ aireg, tmp, repo }) => {
    const cwd = join(tmp, "two-scopes");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await aireg(["init"], { cwd });
    await aireg(["add", `file://${repo}@v1`, "--select", "lint"], { cwd });

    const before = await aireg(["status"], { cwd });
    expect(before.stderr).not.toMatch(/user scope/);

    await aireg(["add", `file://${repo}@v1`, "--select", "lint", "-g"], { cwd });
    const after = await aireg(["status"], { cwd });
    expect(after.stderr, after.stdout).toMatch(/lint is also installed in your user scope/);

    const asJson = await aireg(["status", "--json"], { cwd });
    expect(JSON.parse(asJson.stdout).data.shadowed).toEqual(["lint"]);

    // From user scope there is no way to know which projects exist.
    const global = await aireg(["status", "-g"], { cwd });
    expect(global.stderr).not.toMatch(/user scope/);
  });

  test("remove -g --all leaves nothing it installed behind", async ({
    aireg,
    home: { dir: home },
  }) => {
    const removed = await aireg(["remove", "-g", "--all"]);
    expect(removed.code, removed.stderr).toBe(0);
    const left = [...TARGET_ROOTS, join(".registry", "artifacts")].flatMap((dir) =>
      existsSync(join(home, dir))
        ? readdirSync(join(home, dir), { recursive: true, withFileTypes: true })
            .filter((entry) => !entry.isDirectory())
            .map((entry) => join(entry.parentPath, entry.name).slice(home.length + 1))
        : [],
    );
    expect(left).toEqual([]);
  });

  test("sync reports a conflict, and never merges it", async ({ aireg, git, tmp }) => {
    const scratch = join(tmp, "sync-flow");
    const mp = join(tmp, "sync-flow-repo");
    let release = 0;
    // Every upstream change is a new version, because that is what a registry
    // publishes: the version directory is written once and never edited.
    const upstream = (body: string) => {
      release += 1;
      return registry(mp).skill(`acme/note@1.${release}.0`, { description: "n", body }).write();
    };
    await upstream("top\nmid\nbottom\n");
    await git.init(mp);
    await git.commit(mp, "initial");

    await mkdir(join(scratch, ".claude"), { recursive: true });
    await writeManifestIn(
      scratch,
      [
        "registries:",
        "  kit:",
        `    source: file://${mp}`,
        "artifacts:",
        "  - kit/acme/skill/note",
      ].join("\n"),
    );
    expect((await aireg(["install"], { cwd: scratch })).code).toBe(0);

    expect((await aireg(["sync"], { cwd: scratch })).code).toBe(0);
    await writeFile(
      projected(scratch, "note"),
      "---\nname: note\ndescription: n\n---\nMINE\nmid\nbottom\n",
    );

    // Both moved: reported, never reconciled, and nothing on disk is touched.
    await upstream("top\nmid\nTHEIRS\n");
    await git.commit(mp, "theirs");
    const staged = projected(scratch, "note");
    const before = await readFile(staged, "utf8");
    const lockBefore = await readFile(lockPath(scratch), "utf8");
    const conflict = await aireg(["sync", "--dry-run"], { cwd: scratch });
    expect(conflict.code).toBe(3);
    expect(conflict.stdout).toMatch(/conflict/);
    // Which files differ would need the base bytes, which nothing keeps: a
    // conflict says both sides moved, and the person looks.
    expect(conflict.stdout).toMatch(/edited here and changed in the registry/);
    expect(conflict.stderr).toMatch(/sync resolve \S+ --theirs/);

    const reconciled = await aireg(["sync", "--json"], { cwd: scratch });
    expect(reconciled.code).toBe(3);
    expect(JSON.parse(reconciled.stdout).data.runs).toEqual([
      expect.objectContaining({
        registry: "kit",
        artifacts: [expect.objectContaining({ outcome: "attention" })],
      }),
    ]);
    expect(await readFile(staged, "utf8")).toBe(before);
    expect(await readFile(lockPath(scratch), "utf8")).toBe(lockBefore);
    expect(before).not.toContain("<<<<<<<");
  });

  test("sync sees content, status sees the link", async ({ aireg, tmp, repo }) => {
    const cwd = join(tmp, "sync-links");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeManifestIn(
      cwd,
      [
        "registries:",
        "  kit:",
        `    source: file://${repo}`,
        "artifacts:",
        "  - kit/skill/lint",
      ].join("\n"),
    );
    // One named target, so which links exist does not depend on what the
    // machine running this happens to have installed.
    expect((await aireg(["install", "--for", "claude-code"], { cwd })).code).toBe(0);
    expect((await aireg(["status"], { cwd })).code).toBe(0);

    // A link removed, content untouched: only `status` models projection. In a
    // project the link is per artifact, because plugins are a user-scope thing.
    await rm(join(cwd, ".claude", "skills", "lint"), { force: true, recursive: true });
    const broken = await aireg(["status"], { cwd });
    expect(broken.code).toBe(3);
    expect(broken.stdout).toMatch(/missing/);
    expect((await aireg(["sync"], { cwd })).code).toBe(0);
    expect((await aireg(["install", "--for", "claude-code"], { cwd })).code).toBe(0);
    expect((await aireg(["status"], { cwd })).code).toBe(0);
  });
});

describe("an address without transport security", () => {
  test("is refused before anything goes on the network, with the address to use", async ({
    aireg,
  }) => {
    for (const address of ["http://example.invalid/acme/kit", "git://example.invalid/acme/kit"]) {
      const added = await aireg(["registry", "add", address, "--dry-run"]);
      expect(added.code, added.stderr).toBe(2);
      expect(added.stderr).toContain("which has no transport security.");
      expect(added.stderr).toMatch(/hint: Add its https:\/\//);
    }
  });
});
