import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { roots as makeRoots } from "#core/store/paths.ts";
import type { Loaded } from "#engine/pipeline.ts";
import { test } from "#test/kit/fixtures.ts";
import { fromArgs } from "./work.ts";

// A repository ships its .registry folder, so a link there could point an installed copy at your home.
test.for([
  ["a real folder", false],
  ["a symlinked .registry/artifacts", true],
] as const)("reads an installed copy to publish only through %s", async ([, linked], { tmp }) => {
  const roots = makeRoots("project", join(tmp, "project"));
  const real = linked ? join(tmp, "outside") : roots.artifacts;
  await mkdir(join(real, "acme", "eng", "skills", "lint"), { recursive: true });
  await writeFile(
    join(real, "acme", "eng", "skills", "lint", "SKILL.md"),
    "---\nname: lint\n---\n",
  );
  if (linked) {
    await mkdir(join(roots.cwd, ".registry"), { recursive: true });
    await symlink(real, roots.artifacts);
  }
  const loaded = {
    roots,
    lock: {
      registries: {},
      artifacts: { lint: { registry: "acme", namespace: "eng", name: "lint", kind: "skill" } },
    },
  } as unknown as Loaded;

  const works = fromArgs(["lint"], loaded, roots.cwd);

  if (linked) await expect(works).rejects.toThrow(/lint was not published because .* is a symlink/);
  else
    expect((await works).map((work) => work.path)).toEqual([
      join(real, "acme", "eng", "skills", "lint"),
    ]);
});
