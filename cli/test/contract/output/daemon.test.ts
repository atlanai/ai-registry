import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("daemon");

// Service managers that know no aireg service, so autostart never reaches the real one; on
// Windows it would edit the user's registry instead.
test.skipIf(process.platform === "win32")(
  "each daemon action prints data its schema describes",
  async ({ aireg, tmp }) => {
    const stubs = join(tmp, "service-managers");
    await mkdir(stubs, { recursive: true });
    for (const name of ["launchctl", "systemctl"]) {
      await writeFile(join(stubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    const stubbed = { env: { PATH: `${stubs}:${process.env.PATH ?? ""}` } };
    const check = async (args: string[], action: string) =>
      expect(
        await contract.violations(
          (argv, options) => aireg(argv, { ...options, ...stubbed }),
          ["daemon", ...args],
          action,
        ),
      ).toBe("");

    await check(["status"], "status");
    await check(["start"], "start");
    await check(["status"], "status");
    await check(["restart"], "restart");
    await check(["stop"], "stop");
    await check(["autostart", "status"], "autostart");
    await check(["autostart", "off"], "autostart");
    expect(contract.unchecked()).toEqual([]);
  },
);
