import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { UI_DISCOVERY_INDEX_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { DiscoveryIndex } from "./index.ts";

const entry = { fingerprint: "a".repeat(64), vector: [1, 0] };
test("persists a private rebuildable index without names or source text", async ({ tmp }) => {
  const cache = new DiscoveryIndex({ AIREG_HOME: tmp });
  expect((await cache.read()).size).toBe(0);
  await cache.save([entry]);
  expect((await new DiscoveryIndex({ AIREG_HOME: tmp }).read()).get(entry.fingerprint)).toEqual(
    entry,
  );
  expect((await stat(join(tmp, UI_DISCOVERY_INDEX_FILE))).mode & 0o777).toBe(0o600);
  await cache.save([]);
  expect((await cache.read()).size).toBe(0);
});
test("invalid or incompatible caches rebuild without trusting their vectors", async ({ tmp }) => {
  const cache = new DiscoveryIndex({ AIREG_HOME: tmp });
  for (const body of [
    "broken",
    JSON.stringify({ schema: 1, model: "old-model", entries: [entry] }),
    JSON.stringify({
      schema: 1,
      model: "gemini-embedding-2",
      entries: [{ ...entry, vector: [1e100] }],
    }),
  ]) {
    await writeFile(join(tmp, UI_DISCOVERY_INDEX_FILE), body);
    expect((await cache.read()).size).toBe(0);
  }
});
test("refuses linked cache files for both reads and writes", async ({ tmp }) => {
  const home = join(tmp, "home");
  await mkdir(home);
  const target = join(tmp, "untouched");
  await writeFile(target, "sentinel");
  await symlink(target, join(home, UI_DISCOVERY_INDEX_FILE));
  const cache = new DiscoveryIndex({ AIREG_HOME: home });
  await expect(cache.read()).rejects.toThrow("safely");
  await expect(cache.save([entry])).rejects.toThrow("safely");
  expect(await readFile(target, "utf8")).toBe("sentinel");
});
