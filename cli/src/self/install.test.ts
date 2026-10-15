import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { executableFile } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { installedVersion, previousInstalled, rollback, versionsToPrune } from "./install.ts";

describe("versionsToPrune", () => {
  test("drops the oldest after keeping n newest", () => {
    expect(versionsToPrune(["0.1.0", "0.3.0", "0.2.0"], 2)).toEqual(["0.1.0"]);
  });
});

describe("rollback", () => {
  test("points current at the newest version that is not current", async ({ tmp }) => {
    const home = tmp;
    const env = { AIREG_HOME: home };
    const cli = join(home, "cli");
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
      await mkdir(join(cli, version), { recursive: true });
      await writeFile(join(cli, version, executableFile()), version);
    }
    if (process.platform === "win32") await writeFile(join(cli, "current"), "0.3.0\n");
    else await symlink("0.3.0", join(cli, "current"));
    expect(await previousInstalled(env)).toBe("0.2.0");
    expect(await rollback(env)).toBe("0.2.0");
    expect(await installedVersion(env)).toBe("0.2.0");
  });

  test("says there is nothing to roll back to before any update", async ({ tmp }) => {
    const home = tmp;
    await expect(rollback({ AIREG_HOME: home })).rejects.toMatchObject({
      name: "AiregError",
      message: "No earlier version of aireg is installed to roll back to.",
    });
  });
});
