import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("self");

// A rollback dry run reads only the versions on disk, so it needs no release server.
test("each self action prints data its schema describes", async ({ aireg, home, tmp }) => {
  await mkdir(join(home.aireg, "cli", "0.0.1"), { recursive: true });
  expect(
    await contract.violations(aireg, ["self", "update", "--rollback", "--dry-run"], "update"),
  ).toBe("");

  // Knows no aireg service, so the survey never reaches the real service manager.
  const stubs = join(tmp, "service-managers");
  await mkdir(stubs, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    await writeFile(join(stubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const away = { cwd: home.dir, env: { PATH: `${stubs}:${process.env.PATH}` } };
  const uninstall = ["self", "uninstall", "--dry-run"];
  expect(await contract.violations((args) => aireg(args, away), uninstall, "uninstall")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
