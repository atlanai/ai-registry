import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { requireRegistry } from "./init.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

async function folder(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(scratch, "aireg-root-"));
  for (const file of files) await writeFile(join(dir, file), "");
  return dir;
}

describe("requireRegistry", () => {
  test("finds the folder holding registry.json", async () => {
    const dir = await folder(["registry.json"]);
    expect(requireRegistry(dir)).toBe(dir);
  });

  test("says how to make a registry when the folder is not one", async () => {
    const dir = await folder([]);
    expect(() => requireRegistry(dir)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining("aireg registry init") }),
    );
  });
});
