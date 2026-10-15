import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, vi } from "vitest";
import { authored, copyAuthored, pruneEmptyParent } from "#core/fs/tree.ts";
import { test } from "#test/kit/fixtures.ts";

// A file swapped for a link between the listing and the copy, which only a race produces.
const swapped = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("#adapter/files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#adapter/files.ts")>();
  return {
    ...actual,
    copyRegular: (root: string, path: string, to: string) =>
      path === swapped.path
        ? Promise.resolve({ kind: "refused", reason: "is a symlink" })
        : actual.copyRegular(root, path, to),
  };
});

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});

describe("authored", () => {
  // mkfifo is POSIX; Windows has no named pipe in a folder.
  test.skipIf(process.platform === "win32")(
    "leaves VCS and OS litter out, and names every symlink and special file",
    async () => {
      const skill = join(root, "skill");
      await mkdir(join(skill, ".git"), { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "body");
      await writeFile(join(skill, ".DS_Store"), "x");
      await writeFile(join(skill, ".git", "config"), "x");
      await writeFile(join(root, "secret"), "x");
      await symlink(join(root, "secret"), join(skill, "leak.txt"));
      await promisify(execFile)("mkfifo", [join(skill, "pipe")]);

      const found = await authored(skill);
      expect(found.files.map((file) => file.path)).toEqual(["SKILL.md"]);
      expect(found.irregular).toEqual([
        { path: "leak.txt", reason: "is a symlink" },
        { path: "pipe", reason: "is not a regular file" },
      ]);
    },
  );

  test("leaves dependency folders out, and names every file that may hold credentials", async () => {
    const skill = join(root, "skill");
    await mkdir(join(skill, "node_modules", "x"), { recursive: true });
    await mkdir(join(skill, "keys"), { recursive: true });
    await writeFile(join(skill, "node_modules", "x", "index.js"), "x");
    for (const name of [
      "SKILL.md",
      ".env",
      ".env.local",
      ".env.example",
      "credentials.json",
      "id_rsa",
      "id_rsa.pub",
      ".npmrc",
    ]) {
      await writeFile(join(skill, name), "x");
    }
    await writeFile(join(skill, "keys", "server.pem"), "x");

    const found = await authored(skill);
    expect(found.files.map((file) => file.path)).toEqual([
      ".env.example",
      "id_rsa.pub",
      "SKILL.md",
    ]);
    expect(found.irregular.map((entry) => entry.path)).toEqual([
      ".env",
      ".env.local",
      ".npmrc",
      "credentials.json",
      "id_rsa",
      "keys/server.pem",
    ]);
    expect(new Set(found.irregular.map((entry) => entry.reason))).toEqual(
      new Set(["may hold credentials"]),
    );
  });
});

describe("pruneEmptyParent", () => {
  test("removes every empty folder up to the store root, and keeps the root", async () => {
    const store = join(root, ".registry", "artifacts");
    await mkdir(join(store, "acme", "engineering", "skills"), { recursive: true });
    await pruneEmptyParent(join(store, "acme", "engineering", "skills", "lint"), store);
    expect(await readdir(store)).toEqual([]);
  });

  test("stops at the first folder that still holds something", async () => {
    const store = join(root, ".registry", "artifacts");
    await mkdir(join(store, "acme", "engineering", "skills"), { recursive: true });
    await mkdir(join(store, "acme", "sales"), { recursive: true });
    await pruneEmptyParent(join(store, "acme", "engineering", "skills", "lint"), store);
    expect(await readdir(join(store, "acme"))).toEqual(["sales"]);
  });

  test("removes only the immediate parent outside the store", async () => {
    const store = join(root, ".registry", "artifacts");
    await mkdir(store, { recursive: true });
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await pruneEmptyParent(join(root, ".claude", "skills", "lint"), store);
    expect(await readdir(join(root, ".claude"))).toEqual([]);
    expect((await readdir(root)).sort()).toEqual([".claude", ".registry"]);
  });
});

describe("copyAuthored", () => {
  test("copies regular files and leaves litter out", async () => {
    const skill = join(root, "skill");
    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "body");
    await writeFile(join(skill, "scripts", "run.sh"), "echo");
    await chmod(join(skill, "scripts", "run.sh"), 0o755);
    await writeFile(join(skill, ".DS_Store"), "x");

    expect(await copyAuthored(skill, join(root, "copy"))).toBeUndefined();
    expect((await readdir(join(root, "copy"))).sort()).toEqual(["SKILL.md", "scripts"]);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "copy", "scripts", "run.sh"))).mode & 0o111).not.toBe(0);
    }
  });

  test("refuses a link inside the folder and copies nothing", async () => {
    const skill = join(root, "skill");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "body");
    await writeFile(join(root, "creds.txt"), "CANARY");
    await symlink(join(root, "creds.txt"), join(skill, "notes.md"));

    expect(await copyAuthored(skill, join(root, "copy"))).toEqual({
      path: "notes.md",
      reason: "is a symlink",
    });
    await expect(stat(join(root, "copy"))).rejects.toThrow();
  });

  test("keeps the previous copy when the new one is refused part way", async () => {
    const skill = join(root, "skill");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "two");
    await writeFile(join(skill, "zz.md"), "late");
    await mkdir(join(root, "copy"));
    await writeFile(join(root, "copy", "SKILL.md"), "one");

    swapped.path = "zz.md";
    try {
      expect(await copyAuthored(skill, join(root, "copy"))).toEqual({
        path: "zz.md",
        reason: "is a symlink",
      });
    } finally {
      swapped.path = undefined;
    }
    expect(await readFile(join(root, "copy", "SKILL.md"), "utf8")).toBe("one");
    expect(await readdir(root)).toEqual(["copy", "skill"]);
  });

  test("refuses a folder or file that is itself a link", async () => {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "SKILL.md"), "body");
    await symlink(join(root, "real"), join(root, "skill"));
    await symlink(join(root, "real", "SKILL.md"), join(root, "agent.md"));

    for (const source of ["skill", "agent.md"]) {
      expect(await copyAuthored(join(root, source), join(root, "copy"))).toEqual({
        path: "",
        reason: "is a symlink",
      });
    }
  });

  test("refuses a file that may hold credentials", async () => {
    const skill = join(root, "skill");
    await mkdir(skill);
    await writeFile(join(skill, ".env"), "TOKEN=x");
    expect(await copyAuthored(skill, join(root, "copy"))).toEqual({
      path: ".env",
      reason: "may hold credentials",
    });
  });

  test("copies one file, whatever links lead to the folder it sits in", async () => {
    await mkdir(join(root, "dotfiles", "agents"), { recursive: true });
    await writeFile(join(root, "dotfiles", "agents", "helper.md"), "agent");
    await symlink(join(root, "dotfiles", "agents"), join(root, "agents"));

    expect(await copyAuthored(join(root, "agents", "helper.md"), join(root, "copy.md"))).toBe(
      undefined,
    );
    expect(await readFile(join(root, "copy.md"), "utf8")).toBe("agent");
  });
});
