import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { manifestPath } from "#test/kit/scope.ts";

/** `lint` in one namespace, `deploy` in two, and a skill named `tools` beside the `tools` namespace. */
const test = base.extend("added", async ({ aireg, tmp }) => {
  await registry(join(tmp, "market"), { name: "acme", slug: "acme" })
    .skill("tools/lint@1.0.0")
    .skill("tools/fmt@1.0.0")
    .skill("ops/deploy@1.0.0")
    .skill("infra/deploy@1.0.0")
    .skill("misc/tools@1.0.0")
    .write();
  expect((await aireg(["init", "--for", "claude"])).code).toBe(0);
  expect((await aireg(["registry", "add", join(tmp, "market"), "--as", "acme"])).code).toBe(0);
  return aireg;
});

const declared = async (project: string) => {
  const text = await readFile(manifestPath(project), "utf8");
  return text.slice(text.indexOf("artifacts:"));
};

describe("<registry>/<name>", () => {
  test("installs the one artifact of that name, recorded by its full name", async ({
    added,
    project,
  }) => {
    const ran = await added(["add", "acme/lint", "-y"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(await declared(project)).toBe("artifacts:\n  - acme/tools/skill/lint\n");
  }, 60_000);

  test("is refused when two namespaces have the name, listing both", async ({ added }) => {
    const ran = await added(["add", "acme/deploy", "-y"]);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("acme/deploy matches 2 artifacts.");
    expect(ran.stderr).toContain(
      "Name one of them: acme/infra/skill/deploy or acme/ops/skill/deploy.",
    );
  }, 60_000);

  test("takes a namespace of that name over an artifact of it", async ({ added, project }) => {
    const ran = await added(["add", "acme/tools", "-y"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(await declared(project)).toBe("artifacts:\n  - acme/tools\n");
  }, 60_000);
});
