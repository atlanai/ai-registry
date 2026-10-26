import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { beforeEach, describe, expect } from "vitest";
import { exists } from "#core/fs/tree.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { removal, removeContained } from "./removable.ts";

let root: string;
let project: string;
let outside: string;
let roots: Roots;
let env: NodeJS.ProcessEnv;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  project = join(root, "proj");
  outside = join(root, "shared");
  await mkdir(project, { recursive: true });
  await mkdir(join(outside, "skills", "keys"), { recursive: true });
  await writeFile(join(outside, "skills", "keys", "id"), "canary\n");
  env = { HOME: root, AIREG_HOME: join(root, ".aireg"), AIREG_USER_SCOPE: join(root, ".registry") };
  roots = makeRoots("project", project, env);
});

const how = (path: string, at: Roots = roots) => removal(path, at, env).how;

describe("removal inside a project", () => {
  test("removes what aireg places, where nothing on the way is a link", async () => {
    await mkdir(join(project, ".claude", "skills", "lint"), { recursive: true });
    expect(how(join(project, ".claude", "skills", "lint"))).toBe("remove");
    expect(how(join(roots.artifacts, "kit", "kit", "skills", "lint"))).toBe("remove");
  });

  test("refuses a path outside every folder aireg places things in, and says so", () => {
    expect(removal(join(project, "src"), roots, env)).toEqual({
      how: "refuse",
      reason: "aireg never places anything there",
    });
  });
});

describe("removal through a target directory that is a link", () => {
  test("unlinks its own link there, and only unlinks it", async () => {
    await symlink(outside, join(project, ".claude"));
    const copy = join(roots.artifacts, "kit", "kit", "skills", "lint");
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "SKILL.md"), "ours\n");
    await symlink(copy, join(outside, "skills", "lint"));
    const link = join(project, ".claude", "skills", "lint");

    expect(how(link)).toBe("unlink");
    await removeContained(link, roots, env);
    expect(await exists(join(outside, "skills", "lint"))).toBe(false);
    expect(await exists(join(copy, "SKILL.md"))).toBe(true);
  });

  test("refuses a folder reached through `.claude -> outside`", async () => {
    await symlink(outside, join(project, ".claude"));
    const keys = join(project, ".claude", "skills", "keys");
    expect(how(keys)).toBe("refuse");
    expect(how(join(outside, "skills", "keys"))).toBe("refuse");
    await expect(removeContained(keys, roots, env)).rejects.toThrow(/symlink/);
    expect(await exists(join(outside, "skills", "keys", "id"))).toBe(true);
  });

  test("refuses every path through a target the manifest does not target, `.cursor/skills -> /`", async () => {
    await mkdir(join(project, ".cursor"));
    await symlink("/", join(project, ".cursor", "skills"));
    const keys = join(outside, "skills", "keys");
    for (const path of [keys, "../..", join(".cursor", "skills", relative("/", keys))]) {
      expect(how(path), path).toBe("refuse");
      await removeContained(path, roots, env).catch(() => {});
    }
    expect(await exists(join(keys, "id"))).toBe(true);
  });
});

describe("removal in the user scope", () => {
  let user: Roots;
  beforeEach(() => {
    user = makeRoots("user", root, env);
  });

  test("refuses paths through `~/.cursor/skills -> /`", async () => {
    await mkdir(join(root, ".cursor"));
    await symlink("/", join(root, ".cursor", "skills"));
    const keys = join(outside, "skills", "keys");
    for (const path of [keys, join(root, ".cursor", "skills", relative("/", keys))]) {
      expect(how(path, user), path).toBe("refuse");
      await removeContained(path, user, env).catch(() => {});
    }
    expect(await exists(join(keys, "id"))).toBe(true);
  });

  test("resolves a target root that is itself a link once, as a dotfiles setup has", async () => {
    await symlink(outside, join(root, ".claude"));
    const keys = join(root, ".claude", "skills", "keys");
    expect(how(keys, user)).toBe("remove");
    await removeContained(keys, user, env);
    await expect(lstat(join(outside, "skills", "keys"))).rejects.toThrow();
  });
});
