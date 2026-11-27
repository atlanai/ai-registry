import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath } from "#test/kit/scope.ts";

test("copies only while a run or the manifest asks, never because a lockfile recorded one", async ({
  aireg,
  project,
  tmp,
}) => {
  const reg = join(tmp, "reg");
  await registry(reg, { name: "demo", slug: "demo" }).skill("eng/hello@0.1.0").write();
  expect((await aireg(["init", "--for", "claude-code"])).code).toBe(0);
  const added = await aireg(["add", reg, "--as", "demo", "-s", "hello", "--copy", "-y"]);
  expect(added.code, added.stderr).toBe(0);
  const target = join(project, ".claude", "skills", "hello");
  const linked = async () => (await lstat(target)).isSymbolicLink();
  const install = async (...args: string[]) => {
    const ran = await aireg(["install", ...args]);
    expect(ran.code, ran.stderr).toBe(0);
    return linked();
  };
  expect(await linked()).toBe(false);

  const manifest = await readFile(manifestPath(project), "utf8");
  await writeFile(manifestPath(project), manifest.replace(/\n\s*copy: true/, ""));
  expect(await install()).toBe(true);

  expect(await install("--copy")).toBe(false);
  expect(await install()).toBe(true);

  // A lockfile from a machine that had to copy, cloned where links work.
  const lock = await readFile(lockPath(project), "utf8");
  await writeFile(lockPath(project), lock.replace("mode: symlink", "mode: copy"));
  await rm(target, { recursive: true, force: true });
  expect(await install()).toBe(true);
});
