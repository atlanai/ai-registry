import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { resolveHarnesses } from "#core/harness/index.ts";
import { emptyLock, type Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { candidates, registryPath } from "./adopt.ts";

let root: string;
let roots: Roots;

const harnesses = resolveHarnesses();

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
  test("finds an artifact written into a harness directory", async () => {
    await write(join(root, ".claude", "skills", "mine", "SKILL.md"), skill("mine"));
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["mine"]);
    expect(found.local[0]?.kind).toBe("skill");
    expect(found.local[0]?.suggestedPath).toBe("skills/mine");
  });

  // A harness can keep its own folders beside skills, such as one it syncs
  // into; publishing one as a skill is refused upstream on every run.
  test("skips a directory with no SKILL.md, whatever sits deeper in it", async () => {
    await write(join(root, ".claude", "skills", "mine", "SKILL.md"), skill("mine"));
    await write(
      join(root, ".claude", "skills", "synced", "bucket", "theirs", "SKILL.md"),
      skill("theirs"),
    );
    await mkdir(join(root, ".claude", "skills", "empty"), { recursive: true });
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["mine"]);
  });

  test("never reads back a file written in a harness's own format", async () => {
    await write(join(root, ".codex", "agents", "reviewer.toml"), 'name = "reviewer"\n');
    await write(join(root, ".codex", "skills", "mine", "SKILL.md"), skill("mine"));
    const found = await candidates(roots, harnesses, ["codex"], emptyLock());
    expect(found.local.map((item) => `${item.kind}:${item.name}`)).toEqual(["skill:mine"]);
  });

  test("reads its name from front matter, not from the directory", async () => {
    await write(join(root, ".claude", "skills", "dir-name", "SKILL.md"), skill("real-name"));
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["real-name"]);
  });

  // Anything we placed is a link into the staged tree, whether or not this
  // lock still remembers it.
  test("ignores a link into the staged tree", async () => {
    const staged = join(roots.artifacts, "kit", "eng", "skills", "installed");
    await write(join(staged, "SKILL.md"), skill("installed"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(staged, join(root, ".claude", "skills", "installed"));
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
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
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found.local).toEqual([]);
  });

  // A person's link, such as one into a dotfiles checkout, belongs to whoever made it.
  test("ignores a person's link to a folder outside the store", async () => {
    const elsewhere = join(root, "dotfiles", "skills", "mine");
    await write(join(elsewhere, "SKILL.md"), skill("mine"));
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(elsewhere, join(root, ".claude", "skills", "mine"));
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
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
      links: [{ harness: "claude", path: ".claude/skills/claimed", mode: "symlink" }],
    };
    const found = await candidates(roots, harnesses, ["claude"], lock);
    expect(found.local).toEqual([]);
  });

  // A name the registry publishes is not local work: it is an artifact this
  // project has not declared, which is a different sentence.
  test("separates a name the registry already publishes", async () => {
    await write(join(root, ".claude", "skills", "lint", "SKILL.md"), skill("lint"));
    const found = await candidates(
      roots,
      harnesses,
      ["claude"],
      emptyLock(),
      new Set(["skill:lint"]),
    );
    expect(found.local).toEqual([]);
    expect(found.undeclared.map((item) => item.name)).toEqual(["lint"]);
  });

  test("finds a file-shaped kind too, and its own extension", async () => {
    await write(join(root, ".claude", "agents", "hotfix.md"), "---\ndescription: h\n---\nx\n");
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found.local.map((item) => [item.name, item.kind, item.suggestedPath])).toEqual([
      ["hotfix", "agent", "agents/hotfix.md"],
    ]);
  });

  test("looks only in the harnesses it was given", async () => {
    await write(join(root, ".claude", "skills", "a", "SKILL.md"), skill("a"));
    await write(join(root, ".cursor", "skills", "b", "SKILL.md"), skill("b"));
    const found = await candidates(roots, harnesses, ["cursor"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["b"]);
  });

  test("reports one artifact once, however many harnesses hold it", async () => {
    await write(join(root, ".claude", "skills", "dup", "SKILL.md"), skill("dup"));
    await write(join(root, ".cursor", "skills", "dup", "SKILL.md"), skill("dup"));
    const found = await candidates(roots, harnesses, ["claude", "cursor"], emptyLock());
    expect(found.local.map((item) => item.name)).toEqual(["dup"]);
  });

  test("keeps where else the same artifact sits", async () => {
    await write(join(root, ".claude", "skills", "dup", "SKILL.md"), skill("dup"));
    await write(join(root, ".cursor", "skills", "dup", "SKILL.md"), skill("dup"));
    const found = await candidates(roots, harnesses, ["claude", "cursor"], emptyLock());
    expect(found.local[0]?.elsewhere).toEqual([
      { from: join(root, ".cursor", "skills", "dup"), target: "cursor" },
    ]);
  });

  test("is empty when no harness directory exists", async () => {
    const found = await candidates(roots, harnesses, ["claude"], emptyLock());
    expect(found).toEqual({ local: [], undeclared: [] });
  });
});
