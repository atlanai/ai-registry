import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";

test("prints one document for folders that two jobs watched", async ({ aireg, home, tmp }) => {
  for (const name of ["team", "other"]) {
    const made = await aireg(["registry", "init", join(tmp, name), "--name", name, "-y"]);
    expect(made.code, made.stderr).toBe(0);
    expect((await aireg(["registry", "add", join(tmp, name), "-g"])).code).toBe(0);
  }
  const folders = { team: join(home.dir, "team-skills"), other: join(home.dir, "other-skills") };
  for (const [registry, folder] of Object.entries(folders)) {
    await mkdir(join(folder, "notes"), { recursive: true });
    await writeFile(join(folder, "notes", "SKILL.md"), skillBody("notes"));
    const added = await aireg(["watch", "add", folder, "--to", `${registry}/personal`, "-g"]);
    expect(added.code, added.stderr).toBe(0);
  }

  const removed = await aireg(["watch", "remove", folders.team, folders.other, "-g", "--json"]);

  expect(removed.code, removed.stderr).toBe(0);
  expect(removed.stdout.trim().split("\n")).toHaveLength(1);
  const { jobs } = removed.json<{ jobs: { jobId: string; watching: string[] }[] }>().data ?? {};
  expect(jobs?.map((job) => job.watching)).toEqual([[], []]);
});
