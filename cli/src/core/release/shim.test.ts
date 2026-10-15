import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { standaloneShim } from "./shim.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

function installed(version: string, body: string): string {
  const home = mkdtempSync(join(scratch, "aireg-shim-"));
  mkdirSync(join(home, "cli", version), { recursive: true });
  mkdirSync(join(home, "bin"));
  const binary = join(home, "cli", version, "aireg");
  writeFileSync(binary, body);
  chmodSync(binary, 0o755);
  symlinkSync(version, join(home, "cli", "current"));
  const shim = join(home, "bin", "aireg");
  writeFileSync(shim, standaloneShim());
  chmodSync(shim, 0o755);
  return home;
}

describe("standaloneShim", () => {
  test("is POSIX sh and never mentions Node", () => {
    const shim = standaloneShim();
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).not.toMatch(/node|\.mjs/);
    execFileSync("sh", ["-n"], { input: shim });
  });

  // The shim is for macOS and Linux; Windows puts the binary itself on PATH.
  const posix = test.skipIf(process.platform === "win32");

  posix("execs the binary under cli/current and forwards its arguments", () => {
    const home = installed("1.2.3", '#!/bin/sh\necho "ran $*"\n');
    expect(
      execFileSync(join(home, "bin", "aireg"), ["--version", "--json"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AIREG_HOME: home },
      }).trim(),
    ).toBe("ran --version --json");
  });

  posix("follows the symlink, so a moved current is the whole upgrade", () => {
    const home = installed("1.2.3", "#!/bin/sh\necho one\n");
    mkdirSync(join(home, "cli", "2.0.0"));
    const next = join(home, "cli", "2.0.0", "aireg");
    writeFileSync(next, "#!/bin/sh\necho two\n");
    chmodSync(next, 0o755);
    rmSync(join(home, "cli", "current"));
    symlinkSync("2.0.0", join(home, "cli", "current"));
    expect(
      execFileSync(join(home, "bin", "aireg"), {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AIREG_HOME: home },
      }).trim(),
    ).toBe("two");
  });

  posix("fails with a legible message when the install is gone", () => {
    const home = installed("1.2.3", "#!/bin/sh\necho one\n");
    rmSync(join(home, "cli", "1.2.3"), { recursive: true });
    expect(() =>
      execFileSync(join(home, "bin", "aireg"), {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AIREG_HOME: home },
        stdio: "pipe",
      }),
    ).toThrow(/re-run the installer/);
  });
});
