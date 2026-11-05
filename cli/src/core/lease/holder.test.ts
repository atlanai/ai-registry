import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { readHolder, readHolderSync } from "./holder.ts";
import { metaPath } from "./location.ts";

const holder = {
  id: "h1",
  scope: "user",
  lock: "/home/me/.registry/manifest.lock.yml",
  host: "box",
  pid: 4242,
  acquiredAtMs: 1,
};

describe("readHolder", () => {
  test("reads the holder a claim wrote", async ({ tmp }) => {
    await writeFile(metaPath(tmp), JSON.stringify(holder));
    expect(await readHolder(tmp)).toEqual(holder);
    expect(readHolderSync(tmp)).toEqual(holder);
  });

  test("finds no holder before the claim writes one", async ({ tmp }) => {
    expect(await readHolder(tmp)).toBeUndefined();
    expect(readHolderSync(tmp)).toBeUndefined();
  });

  test("finds no holder in a file a claim has only half written", async ({ tmp }) => {
    await writeFile(metaPath(tmp), JSON.stringify(holder).slice(0, 12));
    expect(await readHolder(tmp)).toBeUndefined();
    expect(readHolderSync(tmp)).toBeUndefined();
  });

  test("finds no holder in one whose fields are off", async ({ tmp }) => {
    await writeFile(metaPath(tmp), JSON.stringify({ ...holder, pid: -1 }));
    expect(await readHolder(tmp)).toBeUndefined();
  });

  test("reports a meta path it cannot read rather than reading it as free", async ({ tmp }) => {
    // A folder where the file belongs fails with EISDIR, which is not absence.
    await mkdir(metaPath(tmp));
    await expect(readHolder(tmp)).rejects.toThrow();
    expect(() => readHolderSync(tmp)).toThrow();
  });
});
