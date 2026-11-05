import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { removeAfterExit } from "./remove-after-exit.ts";

// A pid no process has, so nothing is waited on.
const GONE = 2 ** 22 + 1;

test("deletes an aireg folder once the process is gone, and nothing else", async ({ tmp }) => {
  const home = join(tmp, ".aireg");
  await mkdir(join(home, "cli", "0.1.0"), { recursive: true });
  const other = join(tmp, "notes");
  await mkdir(other);

  await removeAfterExit(GONE, home);
  await removeAfterExit(GONE, other);
  await removeAfterExit(GONE, "relative");
  expect(existsSync(home)).toBe(false);
  expect(existsSync(other)).toBe(true);
});
