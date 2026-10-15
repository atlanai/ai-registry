import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { PACKAGE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { exec } from "#test/kit/run.ts";

const CLI = fileURLToPath(new URL("../../", import.meta.url));

// The scaffold's dev loop, with this build standing in for the published package.
describe("an adapter written outside this repository", () => {
  test("builds and passes its compliance test", async ({ tmp, aireg }) => {
    const dir = join(tmp, "acme");
    expect((await aireg(["adapter", "init", "acme", "--dir", dir])).code).toBe(0);

    const scope = join(dir, "node_modules", ...PACKAGE.split("/").slice(0, -1));
    await mkdir(scope, { recursive: true });
    await symlink(CLI, join(dir, "node_modules", PACKAGE), "junction");
    await mkdir(join(dir, "node_modules", "@types"));
    await symlink(
      join(CLI, "node_modules/@types/node"),
      join(dir, "node_modules/@types/node"),
      "junction",
    );

    // Through node, since Windows has only a .cmd launcher in node_modules/.bin.
    await exec(process.execPath, [join(CLI, "node_modules/typescript/bin/tsc")], { cwd: dir });
    // Named, since node picks its default reporter from the terminal and the CI environment.
    const tested = await exec(
      process.execPath,
      ["--test", "--test-reporter=tap", "test/compliance.test.ts"],
      { cwd: dir },
    );
    expect(tested.stdout).toContain("# pass 1");
    expect(existsSync(join(dir, "dist/index.js"))).toBe(true);
  });
});
