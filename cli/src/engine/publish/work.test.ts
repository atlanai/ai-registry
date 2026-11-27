import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { roots as makeRoots } from "#core/store/paths.ts";
import type { Loaded } from "#engine/scope/load.ts";
import { test } from "#test/kit/fixtures.ts";
import { fromArgs } from "./work.ts";

test("refuses an installed copy reached through a symlinked .registry/artifacts", async ({
  tmp,
}) => {
  const roots = makeRoots("project", join(tmp, "project"));
  const outside = join(tmp, "outside");
  await mkdir(join(outside, "acme", "eng", "skills", "lint"), { recursive: true });
  await writeFile(
    join(outside, "acme", "eng", "skills", "lint", "SKILL.md"),
    "---\nname: lint\n---\n",
  );
  await mkdir(join(roots.cwd, ".registry"), { recursive: true });
  await symlink(outside, roots.artifacts);
  const loaded = {
    roots,
    lock: {
      registries: {},
      artifacts: { lint: { registry: "acme", namespace: "eng", name: "lint", kind: "skill" } },
    },
  } as unknown as Loaded;

  await expect(fromArgs(["lint"], loaded, roots.cwd)).rejects.toThrow(
    /lint was not published because .* is a symlink/,
  );
});

test("quotes the folder a symlink points to so its hint runs as printed", async ({ tmp }) => {
  const roots = makeRoots("user", tmp, { AIREG_USER_SCOPE: join(tmp, "scope") });
  const target = join(tmp, "odd $(id)", "pointed");
  await mkdir(target, { recursive: true });
  await mkdir(join(tmp, "skills"));
  await symlink(target, join(tmp, "skills", "pointed"));
  const loaded = { roots, lock: { registries: {}, artifacts: {} } } as unknown as Loaded;

  await expect(
    fromArgs(["skills/pointed"], loaded, tmp, ["--to", "team/platform", "--dry-run"]),
  ).rejects.toMatchObject({
    hint: `Publish the folder it points to: \`aireg publish '${realpathSync(target)}' --to team/platform --dry-run -g\`.`,
  });
});
