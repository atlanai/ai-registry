import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { canonical } from "./realpath.ts";

test("resolves a directory reached through a link to where it really is", async ({ tmp }) => {
  await mkdir(join(tmp, "real"));
  await symlink(join(tmp, "real"), join(tmp, "via"));

  expect(canonical(join(tmp, "via"))).toBe(await realpath(join(tmp, "real")));
});

test("leaves a path that does not exist as written", () => {
  expect(canonical("/nowhere/at/all")).toBe("/nowhere/at/all");
});
