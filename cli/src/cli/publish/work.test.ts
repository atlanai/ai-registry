import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import type { Loaded } from "#engine/pipeline.ts";
import { test } from "#test/kit/fixtures.ts";
import { fromArgs } from "./work.ts";

/** A project whose lock records lint, installed from acme/eng. */
function installedLint(roots: Roots): Loaded {
  return {
    roots,
    lock: {
      registries: {},
      artifacts: { lint: { registry: "acme", namespace: "eng", name: "lint", kind: "skill" } },
    },
  } as unknown as Loaded;
}

async function writeLint(artifacts: string): Promise<string> {
  const copy = join(artifacts, "acme", "eng", "skills", "lint");
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, "SKILL.md"), "---\nname: lint\n---\n");
  return copy;
}

test("reads an installed copy to publish through real folders", async ({ tmp }) => {
  const roots = makeRoots("project", join(tmp, "project"));
  const copy = await writeLint(roots.artifacts);

  const works = await fromArgs(["lint"], installedLint(roots), roots.cwd);

  expect(works.map((work) => work.path)).toEqual([copy]);
});

// A repository ships its .registry folder, so a link there could point an installed copy at your home.
test("refuses an installed copy reached through a symlinked .registry/artifacts", async ({
  tmp,
}) => {
  const roots = makeRoots("project", join(tmp, "project"));
  const outside = join(tmp, "outside");
  await writeLint(outside);
  await mkdir(join(roots.cwd, ".registry"), { recursive: true });
  await symlink(outside, roots.artifacts);

  await expect(fromArgs(["lint"], installedLint(roots), roots.cwd)).rejects.toThrow(
    /lint was not published because .* is a symlink/,
  );
});
