import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { OUTPUT_SCHEMAS } from "./kit.ts";

test("every published --json schema has a contract test that runs the command", () => {
  const missing = readdirSync(OUTPUT_SCHEMAS)
    .map((name) => name.replace(/\.json$/, ".test.ts"))
    .filter((name) => !existsSync(join(import.meta.dirname, name)));
  expect(missing).toEqual([]);
});
