import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { snapshot } from "./snapshot.ts";
import { parseSource } from "./url.ts";

test("keeps the newest two checkouts of a repository", async ({ tmp, git }) => {
  const work = join(tmp, "work");
  await git.init(work);
  const cache = join(tmp, "cache");
  const spec = parseSource(pathToFileURL(work).href);
  const taken: string[] = [];
  for (const round of [1, 2, 3]) {
    await writeFile(join(work, "note.md"), `round ${round}\n`);
    const commit = await git.commit(work, `round ${round}`);
    const placed = await snapshot(() => cache, spec, undefined, commit, { timeoutMs: 60_000 });
    taken.push(placed.root);
  }
  const kept = await readdir(dirname(taken[2] as string));
  expect(kept.sort()).toEqual(
    taken
      .slice(1)
      .map((root) => basename(root))
      .sort(),
  );
});

test("refuses a checkout that is not at the commit it was asked for", async ({ tmp, git }) => {
  const work = join(tmp, "work");
  await git.init(work);
  await writeFile(join(work, "note.md"), "one\n");
  await git.commit(work, "one");
  const spec = parseSource(pathToFileURL(work).href);
  const asked = "main";
  await expect(
    snapshot(() => join(tmp, "cache"), spec, undefined, asked, { timeoutMs: 60_000 }),
  ).rejects.toThrow(/not the commit/);
  expect(await readdir(tmp)).not.toContain("cache");
});
