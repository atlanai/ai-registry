import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";

// Publish never ships OS litter such as `.DS_Store`, so a file manager leaving one in a copy
// is no local edit: status still reads the copy as ok, and remove still takes it.
const STORE = ".registry/artifacts/acme/platform/skills/lint";

test("status and remove ignore .DS_Store in the stored copy and in a --copy target", async ({
  aireg,
  git,
  tmp,
  project,
}) => {
  const market = join(tmp, "market");
  await registry(market, { name: "acme", slug: "acme" })
    .skill("platform/lint@1.0.0", { body: "lint 1\n" })
    .skill("platform/fmt@1.0.0", { body: "fmt 1\n" })
    .write();
  await git.init(project);
  expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  expect((await aireg(["add", "acme/platform/skill/lint", "-y"])).code).toBe(0);
  expect((await aireg(["add", "acme/platform/skill/fmt", "-y", "--copy"])).code).toBe(0);
  expect((await aireg(["status"])).code).toBe(0);

  await writeFile(join(project, STORE, ".DS_Store"), "finder");
  await writeFile(join(project, ".claude", "skills", "fmt", ".DS_Store"), "finder");

  const seen = await aireg(["status", "--json"]);
  const artifacts: { name: string; state: string }[] = JSON.parse(seen.stdout).data.artifacts;
  const states = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.state]));
  expect(states).toEqual({ fmt: "ok", lint: "ok" });
  expect(seen.code).toBe(0);

  const removed = await aireg(["remove", "fmt", "-y"]);
  expect(removed.code, removed.stderr).toBe(0);
});
