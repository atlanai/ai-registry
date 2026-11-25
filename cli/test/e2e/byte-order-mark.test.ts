import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

// As Windows PowerShell 5.1 saves it: a byte order mark, then CRLF lines.
const SKILL =
  "\uFEFF---\r\nname: pdf-tools\r\ndescription: Extract text from PDF files.\r\n---\r\n";

describe("a SKILL.md saved with a byte order mark", () => {
  test("status names it from its front matter, not its folder", async ({ aireg, home }) => {
    const folder = join(home.dir, ".claude", "skills", "pdf");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), SKILL);
    const ran = await aireg(["status", "-g", "--json"], { cwd: home.dir });
    expect(ran.code, ran.stderr).toBe(0);
    const names = JSON.parse(ran.stdout).data.unmanaged.map((item: { name: string }) => item.name);
    expect(names).toEqual(["pdf-tools"]);
  });

  test("publishes with its front matter's name and description", async ({
    aireg,
    git,
    project,
  }) => {
    await git.init(project);
    await writeManifestIn(project, "registries: {}\nartifacts: []\n");
    await mkdir(join(project, "pdf"));
    await writeFile(join(project, "pdf", "SKILL.md"), SKILL);
    const made = await aireg(["registry", "init", "registry", "--name", "fixture", "-y"]);
    expect(made.code, made.stderr).toBe(0);
    const sent = await aireg(["publish", "pdf", "--to", "./registry/engineering", "-y"]);
    expect(sent.code, sent.stderr).toBe(0);
    const stored = join(project, "registry/artifacts/engineering/skill/pdf-tools/0.1.0");
    const envelope = JSON.parse(await readFile(join(stored, "artifact.json"), "utf8"));
    expect(envelope.metadata).toMatchObject({
      name: "pdf-tools",
      description: "Extract text from PDF files.",
    });
    expect(await readFile(join(stored, "SKILL.md"), "utf8")).toBe(SKILL);
  });
});
