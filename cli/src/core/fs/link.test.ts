import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { fanOut, inspect } from "./link.ts";

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});
async function projection(): Promise<string> {
  const dir = join(root, "store", "plugin");
  await mkdir(join(dir, ".manifest"), { recursive: true });
  await mkdir(join(dir, "skills"), { recursive: true });
  await writeFile(join(dir, "plugin.json"), "{}");
  return dir;
}

describe("fan-out links", () => {
  test("links each content directory, and copies each manifest as a real file", async () => {
    const source = await projection();
    await writeFile(join(source, ".manifest", "plugin.json"), '{"name":"sales"}');
    const to = join(root, "cache", "acme", "sales", "local");
    await fanOut(source, to);
    expect((await lstat(to)).isDirectory()).toBe(true);
    const skills = join(to, "skills");
    expect((await lstat(skills)).isSymbolicLink()).toBe(true);
    expect(await readlink(skills)).not.toMatch(/^\//);
    expect(await realpath(skills)).toBe(join(source, "skills"));
    // A target may refuse a manifest it reaches through a link.
    for (const manifest of ["plugin.json", ".manifest", join(".manifest", "plugin.json")]) {
      expect((await lstat(join(to, manifest))).isSymbolicLink()).toBe(false);
    }
    expect(await readFile(join(to, ".manifest", "plugin.json"), "utf8")).toBe('{"name":"sales"}');
  });

  test("rewrites a copied manifest when the source's changes", async () => {
    const source = await projection();
    const to = join(root, "cache", "acme", "sales", "local");
    await fanOut(source, to);
    await writeFile(join(source, "plugin.json"), '{"version":"2"}');
    await fanOut(source, to);
    expect(await readFile(join(to, "plugin.json"), "utf8")).toBe('{"version":"2"}');
  });

  // A target reading the plugin during a refresh must not find an entry missing.
  test("leaves an entry that is already right in place", async () => {
    const source = await projection();
    const to = join(root, "cache", "acme", "sales", "local");
    await fanOut(source, to);
    const before = await Promise.all(
      ["skills", "plugin.json"].map((entry) => lstat(join(to, entry))),
    );
    await fanOut(source, to);
    const after = await Promise.all(
      ["skills", "plugin.json"].map((entry) => lstat(join(to, entry))),
    );
    expect(after.map((info) => info.ino)).toEqual(before.map((info) => info.ino));
  });

  test("drops an entry the source no longer has, and adds a new one", async () => {
    const source = await projection();
    const to = join(root, "cache", "acme", "sales", "local");
    await fanOut(source, to);
    await rm(join(source, "skills"), { recursive: true });
    await mkdir(join(source, "agents"));
    await mkdir(join(source, "skills-v2"));
    await fanOut(source, to);
    await expect(lstat(join(to, "skills"))).rejects.toThrow();
    expect((await lstat(join(to, "agents"))).isSymbolicLink()).toBe(true);
  });

  test("links an entry that is itself a link by its own name, not where it resolves", async () => {
    const source = await projection();
    const content = join(root, "store", "content", "skills");
    await mkdir(content, { recursive: true });
    await rm(join(source, "skills"), { recursive: true });
    await symlink(content, join(source, "skills"));
    const to = join(root, "cache", "acme", "sales", "local");
    await fanOut(source, to);
    expect(await inspect(to)).toEqual({ exists: true, isLink: true, target: source });
    expect(await realpath(join(to, "skills"))).toBe(content);
  });

  test("does not mistake a person's folder for one", async () => {
    const mine = join(root, "mine");
    await mkdir(mine);
    await writeFile(join(mine, "SKILL.md"), "x");
    expect(await inspect(mine)).toEqual({ exists: true, isLink: false, target: undefined });
    const mixed = join(root, "mixed");
    await mkdir(mixed);
    await symlink(join(root, "a", "one"), join(mixed, "one"));
    await symlink(join(root, "b", "two"), join(mixed, "two"));
    expect((await inspect(mixed)).isLink).toBe(false);
    const empty = join(root, "empty");
    await mkdir(empty);
    expect((await inspect(empty)).isLink).toBe(false);
  });
});
