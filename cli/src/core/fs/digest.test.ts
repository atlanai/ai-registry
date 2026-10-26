import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { digest } from "./digest.ts";

const past = (seconds: number) => new Date(Date.now() - seconds * 1000);

async function tree(root: string, files: Record<string, string>): Promise<string> {
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  return root;
}

test("sees an edit to a copy it digested before, even one of the same size", async ({ tmp }) => {
  const copy = join(tmp, "copy");
  await mkdir(copy);
  const file = join(copy, "SKILL.md");
  await writeFile(file, "one\n");
  await utimes(file, past(60), past(60));
  const before = await digest(copy);
  expect(await digest(copy)).toBe(before);

  await writeFile(file, "two\n");
  await utimes(file, past(30), past(30));
  expect(await digest(copy)).not.toBe(before);
});

test("tells apart two trees whose files run together into the same bytes", async ({ tmp }) => {
  const one = await tree(join(tmp, "one"), { "a.md": "x b.md 0 y" });
  const two = await tree(join(tmp, "two"), { "a.md": "x", "b.md": "y" });

  expect(await digest(one)).not.toBe(await digest(two));
});

test("reads a copy as untouched by the digest an older lock records, until it is edited", async ({
  tmp,
}) => {
  const copy = await tree(join(tmp, "copy"), { "SKILL.md": "hello\n" });
  const lone = join(tmp, "agent.md");
  await writeFile(lone, "hello\n");
  const unframed = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const recorded = unframed("SKILL.md 0 hello\n ");

  expect(await digest(copy, recorded)).toBe(recorded);
  expect(await digest(lone, unframed("hello\n"))).toBe(unframed("hello\n"));
  await writeFile(join(copy, "SKILL.md"), "edited\n");
  expect(await digest(copy, recorded)).not.toBe(recorded);
});
