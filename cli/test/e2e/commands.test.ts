import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { gitRegistry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { projected } from "#test/kit/target.ts";

describe("a first-run mistake", () => {
  test("says a path for show does not exist", async ({ aireg, tmp }) => {
    const shown = await aireg(["show", "./no-such-skill"], { cwd: tmp });
    expect(shown.code).toBe(1);
    expect(shown.stderr).toMatch(/\.\/no-such-skill does not exist/);
  });

  test("says how to carry on when init cannot read the registry it was given", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await gitRegistry(git, join(tmp, "kit"));
    await git.init(project);
    const typo = `file://${join(tmp, "no-such-registry")}`;
    const first = await aireg(["init", "--registry", typo, "--as", "kit"]);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("code: not_found");
    expect(first.stderr).toContain(
      "hint: Correct the address and run `aireg init --registry <registry> --as kit` again; the project is already set up.",
    );
    const fixed = await aireg(["init", "--registry", `file://${repo}`, "--as", "kit"]);
    expect(fixed.code, fixed.stderr).toBe(0);
  });

  test("refuses a target it does not know, and installs into the ones it does", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    const repo = await gitRegistry(git, join(tmp, "kit"));
    const manifest = (targets: string) =>
      writeManifestIn(
        project,
        [
          `targets: [${targets}]`,
          `registries: { kit: { source: ${JSON.stringify(`file://${repo}`)}, ref: v1 } }`,
          "artifacts: [kit/skill/lint]",
          "",
        ].join("\n"),
      );

    await manifest("myagent");
    const refused = await aireg(["install"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('No target named "myagent".');
    const ids = BUILTIN_TARGETS.map((target) => target.id).sort();
    expect(refused.stderr).toContain(`Use ${ids.slice(0, -1).join(", ")} or ${ids.at(-1)},`);

    await manifest("claude-code");
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(projected(project, "lint").startsWith(join(project, ".claude"))).toBe(true);
    expect(existsSync(join(project, ".myagent"))).toBe(false);
  });

  test("keeps its ignore file inside .registry/ and leaves the project's own alone", async ({
    aireg,
    git,
    project,
  }) => {
    await git.init(project);
    await writeFile(join(project, ".gitignore"), "node_modules\n", "utf8");

    const started = await aireg(["init"]);
    expect(started.code, started.stderr).toBe(0);
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("node_modules\n");
    const own = await readFile(join(project, ".registry", ".gitignore"), "utf8");
    expect(own).toContain("# artifacts/");
    expect(started.stderr).not.toMatch(/git ignores/);

    // Ignoring the whole folder would leave teammates with nothing to install.
    await writeFile(join(project, ".gitignore"), "node_modules\n.registry/\n", "utf8");
    const warned = await aireg(["init", "--force"]);
    expect(warned.code, warned.stderr).toBe(0);
    expect(warned.stderr).toMatch(/git ignores \.registry\/manifest\.yml/);
  });

  test("refuses an import with no registry to go into, and writes nothing", async ({
    aireg,
    project,
  }) => {
    await mkdir(join(project, ".claude"), { recursive: true });
    const refused = await aireg(["init", "--import", "claude"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("Importing needs a registry to import into.");
    expect(existsSync(join(project, ".registry"))).toBe(false);
  });

  test("refuses a project that needs a newer CLI", async ({ aireg, project }) => {
    await writeManifestIn(project, "engines:\n  aireg: 99.0.0\nregistries: {}\nartifacts: []\n");
    const result = await aireg(["install"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/99\.0\.0/);
    expect(result.stderr).toMatch(/self update/);
  });
});
