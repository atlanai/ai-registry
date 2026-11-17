import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { DISCOVERY_RECEIPTS_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { type Receipt, Receipts } from "./receipts.ts";

const receipt: Receipt = {
  requestId: "synthetic",
  at: Date.now(),
  skill: null,
  fingerprint: "",
  handedOff: false,
  feedback: false,
};
test("receipts expire, remain bounded and can be cleared when corrupt", async ({ tmp }) => {
  const store = new Receipts({ AIREG_HOME: tmp });
  await store.save([{ ...receipt, at: Date.now() - 25 * 60 * 60_000 }, receipt]);
  expect(await store.read()).toEqual([receipt]);
  await store.save(Array.from({ length: 101 }, (_, i) => ({ ...receipt, requestId: String(i) })));
  expect(await store.read()).toHaveLength(100);
  expect((await store.read())[0]?.requestId).toBe("1");
  await writeFile(join(tmp, DISCOVERY_RECEIPTS_FILE), "invalid");
  await expect(store.read()).rejects.toThrow("invalid");
  await store.save([]);
  expect(await store.read()).toEqual([]);
});
test("receipt storage refuses symlinks", async ({ tmp }) => {
  const target = join(tmp, "target");
  await writeFile(target, "unchanged");
  await symlink(target, join(tmp, DISCOVERY_RECEIPTS_FILE));
  const store = new Receipts({ AIREG_HOME: tmp });
  await expect(store.read()).rejects.toThrow("safely");
  await expect(store.save([])).rejects.toThrow("safely");
  expect(await readFile(target, "utf8")).toBe("unchanged");
});
