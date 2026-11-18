import * as fs from "node:fs/promises";
import { chmod, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { UI_KEY_FILE } from "#core/product.ts";
import { homeTest } from "#test/kit/fixtures.ts";
import { accepts, launcherKey, nonce, proof } from "./rendezvous.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

test("launcher proofs reject another key, replay, reflection and changed addresses", () => {
  const key = Buffer.alloc(32, 1);
  const challenge = nonce();
  const signature = proof(key, "request", challenge);
  expect(accepts(key, "request", challenge, signature)).toBe(true);
  expect(accepts(Buffer.alloc(32, 2), "request", challenge, signature)).toBe(false);
  expect(accepts(key, "request", nonce(), signature)).toBe(false);
  expect(accepts(key, "response", challenge, signature)).toBe(false);
  expect(accepts(key, "request", "invalid", signature)).toBe(false);
  const response = proof(key, "response", challenge, "address-one");
  expect(accepts(key, "response", challenge, response, "address-one")).toBe(true);
  expect(accepts(key, "response", challenge, response, "address-two")).toBe(false);
});

homeTest("launcher identity is reused and a corrupt key is refused", async ({ tmp }) => {
  const first = await launcherKey(tmp);
  expect(first.equals(await launcherKey(tmp))).toBe(true);
  await writeFile(join(tmp, UI_KEY_FILE), "invalid");
  await expect(launcherKey(tmp)).rejects.toThrow("invalid");
});

homeTest(
  "launcher reads the validated handle even when its pathname is replaced",
  async ({ tmp }) => {
    if (process.platform === "win32") return;
    const path = join(tmp, UI_KEY_FILE);
    const original = Buffer.alloc(32, 1);
    await writeFile(path, original, { mode: 0o600 });
    const lstat = fs.lstat;
    // Reproduce a swap between the old pathname-based permission check and read.
    const spy = vi
      .spyOn(fs, "lstat")
      .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const info = await lstat(...args);
        if (args[0] === path) {
          await rename(path, `${path}-original`);
          await writeFile(path, Buffer.alloc(32, 2), { mode: 0o644 });
          await chmod(path, 0o644);
        }
        return info;
      });
    try {
      expect(await launcherKey(tmp)).toEqual(original);
    } finally {
      spy.mockRestore();
    }
  },
);

homeTest("launcher rejects a symlink or broadly readable key", async ({ tmp }) => {
  if (process.platform === "win32") return;
  const path = join(tmp, UI_KEY_FILE);
  await launcherKey(tmp);
  await chmod(path, 0o644);
  await expect(launcherKey(tmp)).rejects.toThrow("not private");
  await rename(path, `${path}-target`);
  await chmod(`${path}-target`, 0o600);
  await symlink(`${path}-target`, path);
  await expect(launcherKey(tmp)).rejects.toThrow();
});
