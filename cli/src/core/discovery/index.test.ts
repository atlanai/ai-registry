import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { DISCOVERY_INDEX_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { DiscoveryIndex } from "./index.ts";
import { fingerprint } from "./retrieval.ts";

const skill = {
  key: "example/recap",
  name: "recap",
  registry: "example",
  namespace: "",
  version: "1",
  digest: "digest",
  description: "Summarize notes",
};
const entry = { fingerprint: fingerprint(skill), vector: [1, 0], skill };
test("persists a private rebuildable index with searchable metadata but no full source text", async ({
  tmp,
}) => {
  const cache = new DiscoveryIndex({ AIREG_HOME: tmp });
  expect((await cache.read()).entries.size).toBe(0);
  await cache.save([entry]);
  expect(
    (await new DiscoveryIndex({ AIREG_HOME: tmp }).read()).entries.get(entry.fingerprint),
  ).toEqual(entry);
  expect((await stat(join(tmp, DISCOVERY_INDEX_FILE))).mode & 0o777).toBe(0o600);
  await cache.save([]);
  expect((await cache.read()).entries.size).toBe(0);
});
test("invalid or incompatible caches rebuild without trusting their vectors", async ({ tmp }) => {
  const cache = new DiscoveryIndex({ AIREG_HOME: tmp });
  for (const body of [
    "broken",
    JSON.stringify({ schema: 1, model: "old-model", entries: [entry] }),
    JSON.stringify({
      schema: 2,
      complete: true,
      updatedAt: new Date().toISOString(),
      model: "gemini-embedding-2",
      entries: [{ ...entry, vector: [1e100] }],
    }),
  ]) {
    await writeFile(join(tmp, DISCOVERY_INDEX_FILE), body);
    expect((await cache.read()).entries.size).toBe(0);
  }
});
test("refuses linked cache files for both reads and writes", async ({ tmp }) => {
  const home = join(tmp, "home");
  await mkdir(home);
  const target = join(tmp, "untouched");
  await writeFile(target, "sentinel");
  await symlink(target, join(home, DISCOVERY_INDEX_FILE));
  const cache = new DiscoveryIndex({ AIREG_HOME: home });
  await expect(cache.read()).rejects.toThrow("safely");
  await expect(cache.save([entry])).rejects.toThrow("safely");
  expect(await readFile(target, "utf8")).toBe("sentinel");
});
