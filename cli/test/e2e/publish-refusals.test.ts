import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { fileTest as test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let registryRoot: string;
/** Where the artifacts being published are written, outside any target folder. */
let work: string;

test.beforeAll(async ({ aireg, tmp }) => {
  registryRoot = join(tmp, "registry");
  work = join(tmp, "work");
  for (const name of ["lint", "deploy"]) {
    await mkdir(join(work, "skills", name), { recursive: true });
    await writeFile(join(work, "skills", name, "SKILL.md"), skillBody(name));
  }
  await registry(registryRoot, { name: "team", slug: "team" }).write();
  const declared = await aireg(["registry", "add", registryRoot], { cwd: work });
  expect(declared.code, declared.stderr).toBe(0);
});

describe("a refused publish", () => {
  test("refuses a file that may hold credentials, and sends none of it", async ({ aireg }) => {
    await mkdir(join(work, "skills", "keyed"), { recursive: true });
    await writeFile(
      join(work, "skills", "keyed", "SKILL.md"),
      skillBody("keyed", "keyed", "Call the API.\n"),
    );
    await writeFile(join(work, "skills", "keyed", ".env"), "TOKEN=x\n");
    const sent = await aireg(["publish", "skills/keyed", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(sent.code).toBe(1);
    expect(sent.stderr).toMatch(/keyed\/\.env may hold credentials/);
    expect(existsSync(join(registryRoot, "artifacts", "platform", "skill", "keyed"))).toBe(false);
  });

  test("refuses what `registry validate` would reject, and sends none of it", async ({ aireg }) => {
    await mkdir(join(work, "skills", "bare"), { recursive: true });
    await writeFile(
      join(work, "skills", "bare", "SKILL.md"),
      "---\nname: bare\n---\nNo summary.\n",
    );
    const bare = await aireg(["publish", "skills/bare", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toMatch(/platform\/skill\/bare[\s\S]*`description` is required/);
    expect(existsSync(join(registryRoot, "artifacts", "platform", "skill", "bare"))).toBe(false);

    const renamed = ["publish", "skills/deploy", "--to", "team/platform/ship", "--yes"];
    const named = await aireg(renamed, { cwd: work });
    expect(named.code).toBe(1);
    expect(named.stderr).toMatch(/is named "deploy" in its front matter/);
  });

  test("refuses a name in --to that the registry would not take, rather than changing it", async ({
    aireg,
  }) => {
    const sent = await aireg(
      ["publish", "skills/lint", "--to", "team/platform/Lint Two", "--yes"],
      { cwd: work },
    );
    expect(sent.code).toBe(2);
    expect(sent.stderr).toMatch(/"Lint Two" is not a valid artifact name/);
    expect(sent.stderr).toMatch(/lint-two/);
  });

  test("refuses a symlink in what it publishes or indexes, and leaves OS litter out", async ({
    aireg,
  }) => {
    const linked = join(work, "skills", "linked");
    await mkdir(join(work, "shared"), { recursive: true });
    await mkdir(linked);
    await writeFile(
      join(linked, "SKILL.md"),
      skillBody("linked", "linked", "Run scripts/run.sh.\n"),
    );
    await writeFile(join(linked, ".DS_Store"), "x");
    await symlink(join(work, "shared"), join(linked, "scripts"));
    const send = ["publish", "skills/linked", "--to", "team/platform", "--yes"];

    const refused = await aireg(send, { cwd: work });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "linked/scripts is a symlink; an artifact holds regular files only.",
    );
    await rm(join(linked, "scripts"));
    expect((await aireg(send, { cwd: work })).code).toBe(0);
    const version = join(registryRoot, "artifacts", "platform", "skill", "linked", "0.1.0");
    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.files.map((file: { path: string }) => file.path)).toEqual(["SKILL.md"]);

    await symlink(join(work, "shared"), join(version, "scripts"));
    for (const action of ["validate", "index"]) {
      const ran = await aireg(["registry", action, "-y"], { cwd: registryRoot });
      expect(ran.code, action).toBe(1);
      expect(ran.stdout + ran.stderr, action).toMatch(/linked\/0\.1\.0\/scripts:?\s+is a symlink/);
    }
    await rm(join(version, "scripts"));
  });
});
