import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { copyRegular, readRegular, replaceFile } from "./files.ts";

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});

describe("readRegular", () => {
  test("reads a file inside the root, and refuses a link anywhere on the way to one", async () => {
    await mkdir(join(root, "v", "scripts"), { recursive: true });
    await writeFile(join(root, "v", "scripts", "run.sh"), "echo hi");
    await writeFile(join(root, "secret"), "x");
    await symlink(join(root, "secret"), join(root, "v", "leak.txt"));
    await symlink(join(root, "v", "scripts"), join(root, "v", "linked"));

    const read = await readRegular(join(root, "v"), "scripts/run.sh");
    expect(read.kind === "file" && read.bytes.toString()).toBe("echo hi");
    expect(await readRegular(join(root, "v"), "leak.txt")).toEqual({
      kind: "refused",
      reason: "is a symlink",
    });
    expect(await readRegular(join(root, "v"), "linked/run.sh")).toEqual({
      kind: "refused",
      reason: "is a symlink",
    });
    expect(await readRegular(join(root, "v"), "gone.md")).toEqual({ kind: "missing" });
    await expect(readRegular(join(root, "v"), "../secret")).rejects.toThrow(/not a path inside/);
  });
});

describe("copyRegular", () => {
  test("copies a file larger than one read, digested on the way, with its executable bit", async () => {
    await mkdir(join(root, "v"), { recursive: true });
    // Several stream chunks, so the digest has to be taken across all of them.
    const bytes = Buffer.alloc(300 * 1024, "ab");
    await writeFile(join(root, "v", "run.sh"), bytes);
    await chmod(join(root, "v", "run.sh"), 0o755);

    const copied = await copyRegular(join(root, "v"), "run.sh", join(root, "out"));
    expect(copied).toEqual({
      kind: "file",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
      // Windows keeps no executable bit to carry.
      executable: process.platform !== "win32",
    });
    expect((await readFile(join(root, "out"))).equals(bytes)).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "out"))).mode & 0o111).not.toBe(0);
    }
  });

  test("refuses a link, and never writes over a file already there", async () => {
    await mkdir(join(root, "v"), { recursive: true });
    await writeFile(join(root, "v", "a.md"), "a");
    await writeFile(join(root, "secret"), "x");
    await symlink(join(root, "secret"), join(root, "v", "leak.txt"));
    await writeFile(join(root, "taken"), "keep");

    expect(await copyRegular(join(root, "v"), "leak.txt", join(root, "out"))).toEqual({
      kind: "refused",
      reason: "is a symlink",
    });
    expect(await readdir(root)).not.toContain("out");
    await expect(copyRegular(join(root, "v"), "a.md", join(root, "taken"))).rejects.toThrow(
      /EEXIST/,
    );
    expect(await readFile(join(root, "taken"), "utf8")).toBe("keep");
  });
});

describe("replaceFile", () => {
  function held(times: number): { calls: number; move: () => Promise<void> } {
    const state = {
      calls: 0,
      move: async () => {
        state.calls += 1;
        if (state.calls <= times) {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
      },
    };
    return state;
  }

  test("waits on Windows for a reader to let go of the file it replaces", async () => {
    const target = held(2);
    let checks = 0;
    await replaceFile("a.tmp", "a", async () => void checks++, target.move, "win32");
    expect(target.calls).toBe(3);
    expect(checks).toBe(3);
  });

  test("gives up on Windows once the file stays held", async () => {
    const target = held(Number.POSITIVE_INFINITY);
    await expect(
      replaceFile("a.tmp", "a", undefined, target.move, "win32", 50),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(target.calls).toBeGreaterThan(1);
  });

  test("fails at once where a rename never waits on a reader", async () => {
    const target = held(1);
    await expect(replaceFile("a.tmp", "a", undefined, target.move, "linux")).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(target.calls).toBe(1);
  });
});
