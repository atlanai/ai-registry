import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

test("never prints the credentials of the address a registry moves from", async ({
  aireg,
  project,
  tmp,
}) => {
  const mirror = join(tmp, "mirror");
  await cp(ACME, mirror, { recursive: true });
  await mkdir(join(project, ".registry"), { recursive: true });
  const userinfo = ["someone", "synthetic-secret"].join(":");
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    `registries:\n  acme: https://${userinfo}@example.invalid/acme\n`,
  );
  for (const format of [["--json"], []]) {
    const moved = await aireg(["registry", "add", mirror, "--as", "acme", "--dry-run", ...format]);
    expect(moved.code, moved.stderr).toBe(0);
    expect(`${moved.stdout}${moved.stderr}`).not.toContain("synthetic-secret");
  }
});
