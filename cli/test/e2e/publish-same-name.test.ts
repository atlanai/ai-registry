import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";

describe("publishing paths whose skills share a name", () => {
  test("refuses two folders of one skill name in one call, and publishes nothing", async ({
    aireg,
    tmp,
  }) => {
    const work = join(tmp, "work");
    const registryRoot = join(tmp, "registry");
    await skillsFolder(work)
      .file("one/SKILL.md", "---\nname: pdf\ndescription: Extract text.\n---\nUse pdftotext.\n")
      .file("two/SKILL.md", "---\nname: pdf\ndescription: Fill forms.\n---\nUse pdftk.\n")
      .write();
    expect(
      (await aireg(["registry", "init", registryRoot, "--name", "team", "-y"], { cwd: work })).code,
    ).toBe(0);
    expect((await aireg(["registry", "add", registryRoot], { cwd: work })).code).toBe(0);

    const sent = await aireg(["publish", "one", "two", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(sent.code).not.toBe(0);
    expect(sent.stderr).toContain("one and two are both skill pdf");
    const skills = await readdir(join(registryRoot, "artifacts", "platform", "skill")).catch(
      () => [],
    );
    expect(skills).toEqual([]);
  });

  test("publishes one folder named twice once", async ({ aireg, tmp }) => {
    const work = join(tmp, "work");
    const registryRoot = join(tmp, "registry");
    await skillsFolder(work)
      .file("one/SKILL.md", "---\nname: pdf\ndescription: Extract text.\n---\nUse pdftotext.\n")
      .write();
    expect(
      (await aireg(["registry", "init", registryRoot, "--name", "team", "-y"], { cwd: work })).code,
    ).toBe(0);
    expect((await aireg(["registry", "add", registryRoot], { cwd: work })).code).toBe(0);

    const sent = await aireg(["publish", "one", "./one", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(sent.code, sent.stderr).toBe(0);
    const body = await readFile(
      join(registryRoot, "artifacts", "platform", "skill", "pdf", "0.1.0", "SKILL.md"),
      "utf8",
    );
    expect(body).toContain("Use pdftotext.");
  });
});
