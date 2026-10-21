import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Manifest, parseManifest } from "#core/manifest.ts";
import { lock } from "#test/kit/builders/lock.ts";
import { test } from "#test/kit/fixtures.ts";
import { exportsOn, installedPaths } from "./reach.ts";

let base: string;

test.beforeEach(async ({ tmp }) => {
  base = tmp;
  for (const name of ["review", "style"]) {
    await mkdir(join(base, "skills", name), { recursive: true });
    await writeFile(
      join(base, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}.\n---\n`,
    );
  }
  await mkdir(join(base, "agents"), { recursive: true });
  await writeFile(join(base, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
});

function manifestWith(exports: string): Manifest {
  return parseManifest(
    `registries:\n  acme: github.com/acme/agent-registry\nexports:\n${exports}publish:\n  to: [acme/engineering]\n`,
  );
}

describe("exportsOn", () => {
  test("expands a glob, and lets a mapping refine one of its paths", async () => {
    const found = await exportsOn(
      manifestWith(
        "  - skills/*\n  - agents/reviewer.md\n  - path: skills/style\n    publish: false\n",
      ),
      base,
    );
    expect([...found.keys()]).toEqual([
      join(base, "skills", "review"),
      join(base, "skills", "style"),
      join(base, "agents", "reviewer.md"),
    ]);
    expect(found.get(join(base, "skills", "style"))?.publish).toBe(false);
  });

  test("merges every entry that reaches an artifact, combining their dependencies", async () => {
    const found = await exportsOn(
      manifestWith(
        [
          "  - skills/*",
          "  - path: skills/review",
          "    version: 1.0.0",
          "    depends_on: [./skills/style]",
          "  - path: skills/review/SKILL.md",
          "    depends_on: [./agents/reviewer.md, ./skills/style/SKILL.md]",
          "",
        ].join("\n"),
      ),
      base,
    );
    expect(found.get(join(base, "skills", "review"))).toEqual({
      path: "skills/review",
      version: "1.0.0",
      dependsOn: [
        { type: "local", path: "skills/style" },
        { type: "local", path: "agents/reviewer.md" },
      ],
      publish: undefined,
    });
    // The glob alone reaches style, which keeps no rules of its own.
    expect(found.get(join(base, "skills", "style"))).toMatchObject({ path: "skills/*" });
  });

  test("refuses two entries naming one artifact that set it differently, naming both", async () => {
    const manifest = manifestWith(
      "  - path: skills/review\n    version: 1.0.0\n  - path: skills/review/SKILL.md\n    version: 2.0.0\n",
    );
    await expect(exportsOn(manifest, base)).rejects.toMatchObject({
      message:
        'Exports "skills/review" and "skills/review/SKILL.md" set a different `version` for skills/review.',
      hint: "Set `version` in one of them.",
      code: "invalid",
    });
  });

  test("refuses an export that a tracked link takes outside the project", async ({
    git,
    fileTmp,
  }) => {
    const elsewhere = join(fileTmp, "elsewhere", "evil");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "SKILL.md"), "---\nname: evil\ndescription: Evil.\n---\n");
    await symlink(elsewhere, join(base, "skills", "evil"));
    await git.init(base);
    await git(base, "add", "skills");
    await expect(exportsOn(manifestWith("  - skills/*\n"), base)).rejects.toMatchObject({
      message: 'Export "skills/*" reaches skills/evil, which is outside this project.',
      code: "invalid",
    });
    await expect(exportsOn(manifestWith("  - skills/evil\n"), base)).rejects.toThrow(
      "which is outside this project.",
    );
    // A link that stays inside the project publishes what it points to.
    await mkdir(join(base, "lib", "inside"), { recursive: true });
    await writeFile(
      join(base, "lib", "inside", "SKILL.md"),
      "---\nname: inside\ndescription: Inside.\n---\n",
    );
    await symlink(join(base, "lib", "inside"), join(base, "skills", "inside"));
    const found = await exportsOn(manifestWith("  - skills/inside\n"), base);
    expect([...found.keys()]).toEqual([join(base, "skills", "inside")]);
  });

  test("refuses a glob whose expansion leaves the project", async () => {
    // Its braces climb out as `..` would, spelled so no part of it reads as `..`.
    await expect(exportsOn(manifestWith("  - '{.,.}./*'\n"), base)).rejects.toThrow(
      "which is outside this project.",
    );
  });

  test("reaches only what git tracks in a repository", async ({ git }) => {
    await git.init(base);
    await git(base, "add", "skills/review", "agents");
    const found = await exportsOn(manifestWith("  - skills/*\n"), base);
    expect([...found.keys()]).toEqual([join(base, "skills", "review")]);
  });

  test("never reaches what aireg installed there", async () => {
    const installed = lock()
      .registry("acme", { location: "github.com/acme/agent-registry" })
      .artifact("style", { links: [{ harness: "claude", path: "skills/style", mode: "symlink" }] })
      .build();
    const found = await exportsOn(
      manifestWith("  - skills/*\n"),
      base,
      installedPaths(installed, base),
    );
    expect([...found.keys()]).toEqual([join(base, "skills", "review")]);
  });

  test("refuses an entry that names nothing", async () => {
    await expect(exportsOn(manifestWith("  - skills/gone\n"), base)).rejects.toMatchObject({
      message: 'Export "skills/gone" names nothing in this project.',
      code: "not_found",
    });
  });
});
