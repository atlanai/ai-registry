import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";

const FILL = { description: "Fill PDF forms.", body: "Use pdftk.\n" };
const EXTRACT = { description: "Extract text from PDF files.", body: "Use pdftotext.\n" };

describe("unmanaged skills of one name whose files differ", () => {
  test("sync and publish name both copies and take neither until one is named", async ({
    aireg,
    home,
    tmp,
  }) => {
    const registryRoot = join(tmp, "registry");
    const made = await aireg(["registry", "init", registryRoot, "--name", "team", "-y"], {
      cwd: home.dir,
    });
    expect(made.code, made.stderr).toBe(0);
    const added = await aireg(["registry", "add", registryRoot, "-g", "-y"], { cwd: home.dir });
    expect(added.code, added.stderr).toBe(0);
    await skillsFolder(home.dir)
      .skill(".claude/skills/pdf", EXTRACT)
      .skill(".agents/skills/pdf", FILL)
      .skill(".claude/skills/csv", { description: "Clean a CSV file.", body: "Trim cells.\n" })
      .write();

    const preview = await aireg(["sync", "-g", "--dry-run", "--json"], { cwd: home.dir });
    const data = JSON.parse(preview.stdout).data;
    expect(data.local.map((item: { name: string }) => item.name)).toEqual(["csv"]);
    expect(
      data.differing.map((item: { name: string; path: string }) => `${item.name} ${item.path}`),
    ).toEqual(["pdf .claude/skills/pdf", "pdf .agents/skills/pdf"]);

    const sent = await aireg(["publish", "-g", "--to", "team/platform", "--yes"], {
      cwd: home.dir,
    });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stderr).toContain("2 different pdf skills, so none was taken");
    expect(sent.stderr).toContain(".agents/skills/pdf");
    expect(sent.stderr).toContain(".claude/skills/pdf");
    expect(await readdir(join(registryRoot, "artifacts", "platform", "skill"))).toEqual(["csv"]);

    const named = await aireg(
      ["publish", join(home.dir, ".agents", "skills", "pdf"), "--to", "team/platform", "--yes"],
      { cwd: home.dir },
    );
    expect(named.code, named.stderr).toBe(0);
    expect((await readdir(join(registryRoot, "artifacts", "platform", "skill"))).sort()).toEqual([
      "csv",
      "pdf",
    ]);
  });

  test("identical copies of one name are still adopted once", async ({ aireg, home, tmp }) => {
    const registryRoot = join(tmp, "registry");
    expect(
      (await aireg(["registry", "init", registryRoot, "--name", "team", "-y"], { cwd: home.dir }))
        .code,
    ).toBe(0);
    expect(
      (await aireg(["registry", "add", registryRoot, "-g", "-y"], { cwd: home.dir })).code,
    ).toBe(0);
    await skillsFolder(home.dir)
      .skill(".claude/skills/pdf", EXTRACT)
      .skill(".agents/skills/pdf", EXTRACT)
      .write();

    const preview = await aireg(["sync", "-g", "--dry-run", "--json"], { cwd: home.dir });
    const data = JSON.parse(preview.stdout).data;
    expect(data.local.map((item: { name: string }) => item.name)).toEqual(["pdf"]);
    expect(data.differing).toEqual([]);
  });
});
