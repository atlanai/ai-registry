import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UI_KEY_FILE } from "#core/product.ts";
import { homeTest } from "#test/kit/fixtures.ts";
import { accepts, launcherKey, nonce, proof } from "./rendezvous.ts";

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
