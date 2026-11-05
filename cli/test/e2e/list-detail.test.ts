import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

test("shows one artifact by any name it answers to, as the name and copy it is installed under", async ({
  aireg,
  project,
}) => {
  await mkdir(join(project, ".registry"), { recursive: true });
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    `registries:\n  acme: ${ACME}\nartifacts:\n  - ref: acme/engineering/skill/pr-review\n    as: renamed\n`,
  );
  expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
  for (const name of ["renamed", "acme/engineering/skill/pr-review"]) {
    const shown = await aireg(["list", name, "--json"]);
    expect(shown.json().data, name).toMatchObject({
      name: "renamed",
      upstreamName: "pr-review",
      copy: join(".registry", "artifacts", "acme", "engineering", "skills", "renamed"),
    });
  }
});
