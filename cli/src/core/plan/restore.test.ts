import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { exists } from "#core/fs/tree.ts";
import { type BackupItem, listBackups, moveToBackup } from "#core/store/backups.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { resolveTargets } from "#core/target/table.ts";
import { test } from "#test/kit/fixtures.ts";
import { originOf, putBack, standing } from "./restore.ts";

async function skill(at: string, text = "mine\n"): Promise<void> {
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "SKILL.md"), text);
}

/** Moves a person's skill aside as an apply does, and returns the item `backup list` shows. */
async function backedUp(roots: Roots, from: string, within: string): Promise<BackupItem> {
  await moveToBackup(from, roots, "20261019T000000Z", within);
  const [run] = await listBackups(roots);
  return run?.items[0] as BackupItem;
}

describe("originOf", () => {
  test("reads the target's folder back from the run's filing", ({ home, project }) => {
    const table = resolveTargets(process.env);
    const user = makeRoots("user", home.dir);
    const here = makeRoots("project", project);
    const lint = { target: "claude-code", dir: "skills", name: "lint" };
    expect(originOf(lint, table, user, process.env)).toBe(
      join(home.dir, ".claude", "skills", "lint"),
    );
    expect(originOf(lint, table, here, process.env)).toBe(
      join(project, ".claude", "skills", "lint"),
    );
    // An earlier id names the same target.
    expect(originOf({ ...lint, target: "claude" }, table, user, process.env)).toBe(
      join(home.dir, ".claude", "skills", "lint"),
    );
    const agent = { target: "codex", dir: "agents", name: "review.toml" };
    expect(originOf(agent, table, user, process.env)).toBe(
      join(home.dir, ".codex", "agents", "review.toml"),
    );
  });

  test("finds nothing for a target or folder this machine does not have", ({ home }) => {
    const table = resolveTargets(process.env);
    const user = makeRoots("user", home.dir);
    expect(originOf({ target: "gone", dir: "skills", name: "x" }, table, user, process.env)).toBe(
      undefined,
    );
    expect(
      originOf({ target: "claude-code", dir: "rules", name: "x" }, table, user, process.env),
    ).toBe(undefined);
  });
});

describe("putBack", () => {
  test("renames an item back to a free path and tidies the emptied run", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const from = join(home.dir, ".claude", "skills", "lint");
    await skill(from);
    const item = await backedUp(roots, from, "claude-code/skills/lint");
    const table = resolveTargets(process.env);

    expect(await standing(item, table, roots, process.env)).toEqual({ state: "free", to: from });
    expect(await putBack(item, from, roots, process.env)).toEqual({ to: from });
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toBe("mine\n");
    expect(await listBackups(roots)).toEqual([]);
    expect(await exists(join(roots.artifacts, "..", "backups", "20261019T000000Z"))).toBe(false);
  });

  test("never overwrites a taken path unless told to move it aside", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const from = join(home.dir, ".claude", "skills", "lint");
    await skill(from, "old\n");
    const item = await backedUp(roots, from, "claude-code/skills/lint");
    await skill(from, "new\n");
    const table = resolveTargets(process.env);

    expect(await standing(item, table, roots, process.env)).toEqual({ state: "taken", to: from });
    await expect(putBack(item, from, roots, process.env)).rejects.toThrow(/is taken/);
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toBe("new\n");

    const done = await putBack(item, from, roots, process.env, () => "20261020T000000Z");
    const aside = join(roots.artifacts, "..", "backups", "20261020T000000Z", "claude-code");
    expect(done).toEqual({ to: from, replaced: join(aside, "skills", "lint") });
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toBe("old\n");
    expect(await readFile(join(aside, "skills", "lint", "SKILL.md"), "utf8")).toBe("new\n");
  });

  test("leaves aireg's own link alone", async ({ home }) => {
    const roots = makeRoots("user", home.dir);
    const from = join(home.dir, ".claude", "skills", "lint");
    await skill(from);
    const item = await backedUp(roots, from, "claude-code/skills/lint");
    const copy = join(roots.artifacts, "acme", "kit", "skills", "lint");
    await skill(copy, "installed\n");
    await symlink(copy, from);
    const table = resolveTargets(process.env);

    expect(await standing(item, table, roots, process.env)).toEqual({
      state: "installed",
      to: from,
    });
    await expect(putBack(item, from, roots, process.env, () => "x")).rejects.toThrow(/is taken/);
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toBe("installed\n");
  });

  test("refuses to write through a target folder that is a link", async ({ home, tmp }) => {
    const roots = makeRoots("user", home.dir);
    const from = join(home.dir, ".claude", "skills", "lint");
    await skill(from);
    const item = await backedUp(roots, from, "claude-code/skills/lint");
    const outside = join(tmp, "outside");
    await mkdir(outside, { recursive: true });
    // The move left `skills` empty; a link to elsewhere takes its place.
    await rm(join(home.dir, ".claude", "skills"), { recursive: true });
    await symlink(outside, join(home.dir, ".claude", "skills"));
    const table = resolveTargets(process.env);

    expect((await standing(item, table, roots, process.env)).state).toBe("refused");
    await expect(putBack(item, from, roots, process.env)).rejects.toThrow(/Refusing to restore/);
    expect(await exists(join(outside, "lint"))).toBe(false);
    expect(await exists(item.path)).toBe(true);
  });
});
