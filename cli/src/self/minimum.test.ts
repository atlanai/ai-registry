import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { runningEntry } from "#core/release/launch.ts";
import { test } from "#test/kit/fixtures.ts";
import { installTimeoutMs, isInstalledCli, skipMinimumUpdate } from "./minimum.ts";

const home = { AIREG_HOME: "/tmp/aireg-home" };
const installed = join("/tmp/aireg-home/cli/0.1.0/aireg");

describe("isInstalledCli", () => {
  test("is only the installed layout under AIREG_HOME/cli", () => {
    expect(isInstalledCli(installed, home)).toBe(true);
    expect(isInstalledCli("/repo/cli/dist/main.mjs", home)).toBe(false);
    expect(isInstalledCli(undefined, home)).toBe(false);
  });

  test("counts a folder whose name starts with two dots as inside", () => {
    expect(isInstalledCli("/tmp/aireg-home/cli/..0.1.0/aireg", home)).toBe(true);
  });

  test("sees the install through a symlinked home", async ({ tmp }) => {
    const real = tmp;
    try {
      await mkdir(join(real, "cli", "0.1.0"), { recursive: true });
      await writeFile(join(real, "cli", "0.1.0", "aireg"), "");
      await symlink(real, `${real}-link`);
      const entry = join(real, "cli", "0.1.0", "aireg");
      expect(isInstalledCli(entry, { AIREG_HOME: `${real}-link` })).toBe(true);
    } finally {
      await rm(`${real}-link`, { force: true });
    }
  });
});

describe("skipMinimumUpdate", () => {
  test("skips CI, opt-out flags, and source builds", () => {
    expect(skipMinimumUpdate({ ...home, CI: "true" }, installed)).toBe(true);
    expect(skipMinimumUpdate({ ...home, AIREG_DISABLE_UPDATE_CHECK: "1" }, installed)).toBe(true);
    expect(skipMinimumUpdate({ ...home, AIREG_SKIP_MIN_UPDATE: "1" }, installed)).toBe(true);
    expect(skipMinimumUpdate(home, installed)).toBe(true);
  });
});

describe("runningEntry", () => {
  test("is the executable itself for a standalone build, and argv[1] under Node", () => {
    expect(runningEntry(["/x/aireg", "ignored"], "/home/u/.aireg/cli/0.2.0/aireg")).toBe(
      "/home/u/.aireg/cli/0.2.0/aireg",
    );
    expect(runningEntry(["/usr/bin/node", "/repo/bin/aireg.mjs"], "/usr/bin/node")).toBe(
      "/repo/bin/aireg.mjs",
    );
    expect(runningEntry(["/usr/bin/node"], "/usr/bin/node")).toBeUndefined();
  });
});

describe("installTimeoutMs", () => {
  // aireg-windows-amd64.exe in 0.1.8, which took about 790s at 0.15 MB/s against a fixed 600s.
  const largest = 118_758_192;

  test("leaves a large release time to download on a slow link", () => {
    expect(installTimeoutMs(largest)).toBeGreaterThan(790_000);
  });

  test("never drops below ten minutes", () => {
    expect(installTimeoutMs(1024)).toBe(600_000);
  });

  test("covers the largest release when the manifest states no size", () => {
    expect(installTimeoutMs(undefined)).toBeGreaterThan(installTimeoutMs(largest));
  });
});
