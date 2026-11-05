import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { emptyLock, type Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { test } from "#test/kit/fixtures.ts";
import { candidates, danglingLinks, registryPath } from "./adopt.ts";

let root: string;
let roots: Roots;

const targetTable = resolveTargets();

const skill = (name: string) => `---\nname: ${name}\ndescription: written here\n---\nbody\n`;

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  roots = {
    scope: "project",
    cwd: root,
    base: root,
    manifest: join(root, "manifest.yml"),
    lock: join(root, "manifest.lock.yml"),
    artifacts: join(root, ".registry", "artifacts"),
    applyJournal: join(root, ".registry", "apply-journal.json"),
  };
});
describe("registryPath", () => {
  test("files each kind where the scanner would look for it", () => {
    expect(registryPath("skill", "review", "/x/review")).toBe("skills/review");
    // The extension comes from the file, not from the kind.
    expect(registryPath("agent", "adr", "/x/adr.md")).toBe("agents/adr.md");
    expect(registryPath("agent", "adr", "/x/adr")).toBe("agents/adr.md");
  });
});

describe("candidates", () => {
  test("finds an artifact written into a target directory", async () => {
    await write(join(root, ".claude", "skills", "mine", "SKILL.md"), skill("mine"));
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["mine"]);
    expect(found.local[0]?.kind).toBe("skill");
    expect(found.local[0]?.suggestedPath).toBe("skills/mine");
  });

  // A target can keep its own folders beside skills, such as one it syncs
  // into; publishing one as a skill is refused upstream on every run.
  test("skips a directory with no SKILL.md, whatever sits deeper in it", async () => {
    await write(join(root, ".claude", "skills", "mine", "SKILL.md"), skill("mine"));
    await write(
      join(root, ".claude", "skills", "synced", "bucket", "theirs", "SKILL.md"),
      skill("theirs"),
    );
    await mkdir(join(root, ".claude", "skills", "empty"), { recursive: true });
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["mine"]);
  });

  test("never reads back a file written in a target's own format", async () => {
    await write(join(root, ".codex", "agents", "reviewer.toml"), 'name = "reviewer"\n');
    await write(join(root, ".codex", "skills", "mine", "SKILL.md"), skill("mine"));
    const found = await candidates(roots, targetTable, ["codex"], emptyLock());
    expect(found.local.map((item) => `${item.kind}:${item.name}`)).toEqual(["skill:mine"]);
  });

  test("reads its name from front matter, not from the directory", async () => {
    await write(join(root, ".claude", "skills", "dir-name", "SKILL.md"), skill("real-name"));
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["real-name"]);
  });

  // Anything we placed is a link into the staged tree, whether or not this
  // lock still remembers it.
  test("ignores a link into the staged tree", async () => {
    const staged = join(roots.artifacts, "kit", "eng", "skills", "installed");
    await write(join(staged, "SKILL.md"), skill("installed"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(staged, join(root, ".claude", "skills", "installed"));
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local).toEqual([]);
  });

  test("ignores a folder of links into the staged tree, as a projected namespace is", async () => {
    const staged = join(roots.artifacts, "kit", "eng", "skills", "lint");
    await write(join(staged, "SKILL.md"), skill("lint"));
    await mkdir(join(root, ".claude", "skills", "projected"), { recursive: true });
    await symlink(
      join(staged, "SKILL.md"),
      join(root, ".claude", "skills", "projected", "SKILL.md"),
    );
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local).toEqual([]);
  });

  // A person's link, such as one into a dotfiles checkout, belongs to whoever made it.
  test("ignores a person's link to a folder outside the store", async () => {
    const elsewhere = join(root, "dotfiles", "skills", "mine");
    await write(join(elsewhere, "SKILL.md"), skill("mine"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(elsewhere, join(root, ".claude", "skills", "mine"));
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local).toEqual([]);
  });

  test("ignores a path the lockfile claims", async () => {
    await write(join(root, ".claude", "skills", "claimed", "SKILL.md"), skill("claimed"));
    const lock: Lock = emptyLock();
    lock.artifacts.claimed = {
      registry: "kit",
      id: "skills/lint",
      name: "lint",
      kind: "skill",
      namespace: undefined,
      address: "skills/lint",
      path: "artifacts/copy",
      origin: undefined,
      content: "",
      version: undefined,
      digest: "",
      links: [{ target: "claude-code", path: ".claude/skills/claimed", mode: "symlink" }],
    };
    const found = await candidates(roots, targetTable, ["claude-code"], lock);
    expect(found.local).toEqual([]);
  });

  // A name the registry publishes is not local work: it is an artifact this
  // project has not declared, which is a different sentence.
  test("separates a name the registry already publishes", async () => {
    await write(join(root, ".claude", "skills", "lint", "SKILL.md"), skill("lint"));
    const found = await candidates(
      roots,
      targetTable,
      ["claude-code"],
      emptyLock(),
      new Set(["skill:lint"]),
    );
    expect(found.local).toEqual([]);
    expect(found.undeclared.map((item) => item.name)).toEqual(["lint"]);
  });

  test("finds a file-shaped kind too, and its own extension", async () => {
    await write(join(root, ".claude", "agents", "hotfix.md"), "---\ndescription: h\n---\nx\n");
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found.local.map((item) => [item.name, item.kind, item.suggestedPath])).toEqual([
      ["hotfix", "agent", "agents/hotfix.md"],
    ]);
  });

  test("looks only in the targets it was given", async () => {
    await write(join(root, ".claude", "skills", "a", "SKILL.md"), skill("a"));
    await write(join(root, ".cursor", "skills", "b", "SKILL.md"), skill("b"));
    const found = await candidates(roots, targetTable, ["cursor"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["b"]);
  });

  test("reports one artifact once, however many targets hold it, and where else it sits", async () => {
    await write(join(root, ".claude", "skills", "dup", "SKILL.md"), skill("dup"));
    await write(join(root, ".cursor", "skills", "dup", "SKILL.md"), skill("dup"));
    const found = await candidates(roots, targetTable, ["claude-code", "cursor"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["dup"]);
    expect(found.local[0]?.elsewhere).toEqual([
      { from: join(root, ".cursor", "skills", "dup"), target: "cursor" },
    ]);
  });

  test("is empty when no target directory exists", async () => {
    const found = await candidates(roots, targetTable, ["claude-code"], emptyLock());
    expect(found).toEqual({ local: [], undeclared: [] });
  });
});

describe("candidates, for a report", () => {
  const report = (targets: string[], lock: Lock = emptyLock()) =>
    candidates(roots, targetTable, targets, lock, new Set(), { report: true });

  test("finds a person's link to a folder outside the store", async () => {
    const elsewhere = join(root, "dotfiles", "skills", "mine");
    await write(join(elsewhere, "SKILL.md"), skill("mine"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(elsewhere, join(root, ".claude", "skills", "mine"));
    const found = await report(["claude-code"]);
    expect(found.local.map((item) => [item.name, item.from])).toEqual([
      ["mine", join(root, ".claude", "skills", "mine")],
    ]);
  });

  test("names every target that links one folder", async () => {
    const shared = join(root, ".agents", "skills", "shared");
    await write(join(shared, "SKILL.md"), skill("shared"));
    for (const target of [".claude", ".cursor"]) {
      await mkdir(join(root, target, "skills"), { recursive: true });
      await symlink(shared, join(root, target, "skills", "shared"));
    }
    const found = await report(["universal", "claude-code", "cursor"]);
    expect(found.local.map((item) => item.name)).toEqual(["shared"]);
    expect(found.local[0]?.target).toBe("universal");
    expect(found.local[0]?.elsewhere.map((item) => item.target)).toEqual(["claude-code", "cursor"]);
  });

  test("still ignores a link into the staged tree, and one whose target is gone", async () => {
    const staged = join(roots.artifacts, "kit", "eng", "skills", "installed");
    await write(join(staged, "SKILL.md"), skill("installed"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(staged, join(root, ".claude", "skills", "installed"));
    await symlink(join(root, "gone"), join(root, ".claude", "skills", "gone"));
    const found = await report(["claude-code"]);
    expect(found.local).toEqual([]);
  });

  test("reads an agent in the target's own format, by the name it declares", async () => {
    await write(
      join(root, ".codex", "agents", "file-name.toml"),
      'name = "critic"\ndescription = "Reviews code."\ndeveloper_instructions = "Be critical."\n',
    );
    await write(join(root, ".claude", "agents", "critic.md"), skill("critic"));
    const found = await report(["claude-code", "codex"]);
    expect(found.local.map((item) => [item.kind, item.name, item.target])).toEqual([
      ["agent", "critic", "claude-code"],
    ]);
    expect(found.local[0]?.elsewhere).toEqual([
      { from: join(root, ".codex", "agents", "file-name.toml"), target: "codex" },
    ]);
  });

  test("leaves out a file aireg rendered, which the lockfile claims", async () => {
    await write(join(root, ".codex", "agents", "reviewer.toml"), 'name = "reviewer"\n');
    const lock: Lock = emptyLock();
    lock.artifacts.reviewer = {
      registry: "kit",
      id: "agents/reviewer",
      name: "reviewer",
      kind: "agent",
      namespace: undefined,
      address: "agents/reviewer",
      path: "artifacts/reviewer",
      origin: undefined,
      content: "",
      version: undefined,
      digest: "",
      links: [{ target: "codex", path: ".codex/agents/reviewer.toml", mode: "copy" }],
    };
    expect((await report(["codex"], lock)).local).toEqual([]);
  });
});

describe("danglingLinks", () => {
  test("names a link of yours whose target is gone, and what it pointed at", async () => {
    await write(join(root, ".claude", "agents", "live.md"), skill("live"));
    await symlink(join(root, "nowhere.md"), join(root, ".claude", "agents", "gone.md"));
    await symlink(
      join(root, ".claude", "agents", "live.md"),
      join(root, ".claude", "agents", "ok.md"),
    );
    expect(await danglingLinks(roots, targetTable, ["claude-code"], emptyLock())).toEqual([
      {
        path: join(root, ".claude", "agents", "gone.md"),
        linksTo: join(root, "nowhere.md"),
        target: "claude-code",
      },
    ]);
  });

  test("leaves a link aireg made to status's own report of it", async () => {
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(join(roots.artifacts, "gone"), join(root, ".claude", "skills", "lint"));
    const lock: Lock = emptyLock();
    lock.artifacts.lint = {
      registry: "kit",
      id: "skills/lint",
      name: "lint",
      kind: "skill",
      namespace: undefined,
      address: "skills/lint",
      path: "artifacts/lint",
      origin: undefined,
      content: "",
      version: undefined,
      digest: "",
      links: [{ target: "claude-code", path: ".claude/skills/lint", mode: "symlink" }],
    };
    expect(await danglingLinks(roots, targetTable, ["claude-code"], lock)).toEqual([]);
  });

  test("knows a link aireg made when the project is reached through a link", async () => {
    const real = join(root, "real");
    await mkdir(join(real, ".claude", "skills"), { recursive: true });
    await symlink(real, join(root, "alias"));
    const base = join(root, "alias");
    const through = { ...roots, cwd: base, base, artifacts: join(base, ".registry", "artifacts") };
    await symlink(join(root, "gone"), join(real, ".claude", "skills", "lint"));
    const lock: Lock = emptyLock();
    lock.artifacts.lint = {
      registry: "kit",
      id: "skills/lint",
      name: "lint",
      kind: "skill",
      namespace: undefined,
      address: "skills/lint",
      path: "artifacts/lint",
      origin: undefined,
      content: "",
      version: undefined,
      digest: "",
      links: [{ target: "claude-code", path: ".claude/skills/lint", mode: "symlink" }],
    };
    expect(await danglingLinks(through, targetTable, ["claude-code"], lock)).toEqual([]);
  });

  test("leaves a link into the store that the lock no longer names", async () => {
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await mkdir(roots.artifacts, { recursive: true });
    await symlink(join(roots.artifacts, "gone"), join(root, ".claude", "skills", "stale"));
    expect(await danglingLinks(roots, targetTable, ["claude-code"], emptyLock())).toEqual([]);
  });
});
