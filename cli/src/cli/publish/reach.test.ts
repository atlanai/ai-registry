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
  await writeFile(
    join(base, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n",
  );
});

function manifestWith(exports: string): Manifest {
  return parseManifest(
    `registries:\n  acme: github.com/acme/agent-registry\nexports:\n${exports}publish:\n  to: acme/engineering\n`,
  );
}

describe("exportsOn", () => {
  test("expands a glob, and lets a mapping refine one of its paths", async () => {
    const { found } = await exportsOn(
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
    const { found } = await exportsOn(
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
    const { files: _, ...review } = found.get(join(base, "skills", "review")) ?? {};
    expect(review).toEqual({
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
    const { found } = await exportsOn(manifestWith("  - skills/inside\n"), base);
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
    const { found } = await exportsOn(manifestWith("  - skills/*\n"), base);
    expect([...found.keys()]).toEqual([join(base, "skills", "review")]);
  });

  test("publishes only what git tracks inside a folder, and always its entry file", async ({
    git,
  }) => {
    await writeFile(join(base, "skills", "review", "checklist.md"), "Tracked.\n");
    await writeFile(join(base, "skills", "review", "scratch.md"), "Not tracked.\n");
    const manifest = manifestWith("  - skills/review\n  - skills/style\n  - agents/reviewer.md\n");
    const stored = (paths: string[]) => paths.map((path) => ({ from: path, as: path }));
    // Outside a repository every file goes.
    expect(
      (await exportsOn(manifest, base)).found.get(join(base, "skills", "review"))?.files,
    ).toEqual(stored(["SKILL.md", "checklist.md", "scratch.md"]));
    await git.init(base);
    await git(base, "add", "skills/review/SKILL.md", "skills/review/checklist.md");
    const { found } = await exportsOn(manifest, base);
    expect(found.get(join(base, "skills", "review"))?.files).toEqual(
      stored(["SKILL.md", "checklist.md"]),
    );
    expect(found.get(join(base, "skills", "style"))?.files).toEqual(stored(["SKILL.md"]));
    expect(found.get(join(base, "agents", "reviewer.md"))?.files).toBe(undefined);
  });

  test("never reaches what aireg installed there", async () => {
    const installed = lock()
      .registry("acme", { location: "github.com/acme/agent-registry" })
      .artifact("style", { links: [{ harness: "claude", path: "skills/style", mode: "symlink" }] })
      .build();
    const { found } = await exportsOn(
      manifestWith("  - skills/*\n"),
      base,
      installedPaths(installed, base),
    );
    expect([...found.keys()]).toEqual([join(base, "skills", "review")]);
  });

  test("skips what a glob matches that is no artifact, with a note on each", async () => {
    await writeFile(join(base, "agents", "README.md"), "# Agents\n\nWhat lives here.\n");
    await writeFile(join(base, "agents", "draft.md"), "---\nname: draft\n---\nUnfinished.\n");
    await writeFile(join(base, "agents", "notes.txt"), "Ideas.\n");
    await mkdir(join(base, "agents", "shared"));
    const { found, notes } = await exportsOn(manifestWith("  - agents/*\n"), base);
    expect([...found.keys()]).toEqual([join(base, "agents", "reviewer.md")]);
    expect(notes).toEqual([
      "Skipped agents/README.md, which has no name and description in its front matter, so it is no agent.",
      "Skipped agents/draft.md, which has no name and description in its front matter, so it is no agent.",
      "Skipped agents/notes.txt, which is neither a skill folder nor an agent's .md file.",
      "Skipped agents/shared, which holds no SKILL.md.",
    ]);
  });

  test("refuses an entry naming a file or folder that is no artifact", async () => {
    await writeFile(join(base, "agents", "README.md"), "# Agents\n");
    await expect(exportsOn(manifestWith("  - agents/README.md\n"), base)).rejects.toMatchObject({
      message:
        'Export "agents/README.md" is not an artifact: it has no name and description in its front matter, so it is no agent.',
      code: "invalid",
    });
    await expect(exportsOn(manifestWith("  - skills/review/notes.txt\n"), base)).rejects.toThrow(
      "names nothing in this project.",
    );
    await writeFile(join(base, "skills", "review", "notes.txt"), "Ideas.\n");
    await expect(exportsOn(manifestWith("  - skills/review/notes.txt\n"), base)).rejects.toThrow(
      'Export "skills/review/notes.txt" is not an artifact: it is neither a skill folder nor an agent\'s .md file.',
    );
  });

  test("refuses an entry that names nothing", async () => {
    await expect(exportsOn(manifestWith("  - skills/gone\n"), base)).rejects.toMatchObject({
      message: 'Export "skills/gone" names nothing in this project.',
      code: "not_found",
    });
  });
});

describe("exportsOn, for a folder of artifacts", () => {
  test("reaches each artifact directly inside a folder, skipping the rest with a note", async () => {
    await writeFile(join(base, "skills", "README.md"), "# Skills\n");
    await mkdir(join(base, "skills", "review", "deeper", "inner"), { recursive: true });
    await writeFile(
      join(base, "skills", "review", "deeper", "inner", "SKILL.md"),
      "---\nname: inner\ndescription: Inner.\n---\n",
    );
    const { found, notes } = await exportsOn(manifestWith("  - skills\n  - agents\n"), base);
    // Only what is directly inside: the skill below review's folder is part of review.
    expect([...found.keys()]).toEqual([
      join(base, "skills", "review"),
      join(base, "skills", "style"),
      join(base, "agents", "reviewer.md"),
    ]);
    expect(notes).toEqual([
      "Skipped skills/README.md, which has no name and description in its front matter, so it is no agent.",
    ]);
  });

  test("lets an entry naming an artifact decide over its folder's entry", async () => {
    const { found } = await exportsOn(
      manifestWith(
        "  - path: skills\n    version: 1.0.0\n  - path: skills/review\n    version: 2.0.0\n",
      ),
      base,
    );
    expect(found.get(join(base, "skills", "review"))?.version).toBe("2.0.0");
    expect(found.get(join(base, "skills", "style"))).toMatchObject({
      path: "skills",
      version: "1.0.0",
    });
  });

  test("leaves out what `exclude` names, and refuses a name not in the folder", async () => {
    const { found } = await exportsOn(
      manifestWith("  - path: skills\n    exclude: [style]\n"),
      base,
    );
    expect([...found.keys()]).toEqual([join(base, "skills", "review")]);
    await expect(
      exportsOn(manifestWith("  - path: skills\n    exclude: [styel]\n"), base),
    ).rejects.toMatchObject({
      message: 'Export "skills" excludes "styel", which is not in it.',
      code: "not_found",
    });
    await expect(
      exportsOn(manifestWith("  - path: skills/review\n    exclude: [x]\n"), base),
    ).rejects.toThrow(
      'Export "skills/review" sets `exclude`, but it is one artifact, not a folder of them.',
    );
  });

  test("refuses an entry with `kind` that reaches another kind, naming its path", async () => {
    await writeFile(
      join(base, "skills", "helper.md"),
      "---\nname: helper\ndescription: Helps.\n---\n",
    );
    await expect(
      exportsOn(manifestWith("  - path: skills\n    kind: skill\n"), base),
    ).rejects.toMatchObject({
      message: 'Export "skills" reaches skills/helper.md, which is an agent, not a skill.',
      hint: "Leave it out with `exclude`, move it, or remove `kind`.",
      code: "invalid",
    });
    const { found } = await exportsOn(
      manifestWith("  - path: skills\n    kind: skill\n    exclude: [helper.md]\n"),
      base,
    );
    expect(found.get(join(base, "skills", "review"))?.kind).toBe("skill");
  });
});

describe("exportsOn, choosing an artifact's files", () => {
  beforeEachFiles();

  const filesOf = async (exports: string, at = join(base, "skills", "review")) =>
    (await exportsOn(manifestWith(exports), base)).found.get(at)?.files;

  test("publishes only what `include` lists, each at its path, and always the entry file", async () => {
    const files = await filesOf(
      [
        "  - path: skills/review",
        "    include:",
        "      - workspace/AGENTS.md",
        "      - { from: workspace/SOUL.md, as: identity/SOUL.md }",
        "      - docs",
        "",
      ].join("\n"),
    );
    expect(files).toEqual([
      { from: "SKILL.md", as: "SKILL.md" },
      { from: "docs/a.md", as: "docs/a.md" },
      { from: "docs/b/c.md", as: "docs/b/c.md" },
      { from: "workspace/SOUL.md", as: "identity/SOUL.md" },
      { from: "workspace/AGENTS.md", as: "workspace/AGENTS.md" },
    ]);
    // A folder maps to another folder, file by file.
    expect(
      await filesOf("  - path: skills/review\n    include: [{ from: docs, as: guide }]\n"),
    ).toEqual([
      { from: "SKILL.md", as: "SKILL.md" },
      { from: "docs/a.md", as: "guide/a.md" },
      { from: "docs/b/c.md", as: "guide/b/c.md" },
    ]);
  });

  test("refuses an `include` path the artifact does not hold", async () => {
    await expect(
      filesOf("  - path: skills/review\n    include: [workspace/GONE.md]\n"),
    ).rejects.toMatchObject({
      message:
        'Export "skills/review" includes workspace/GONE.md, which skills/review does not hold.',
      code: "not_found",
    });
  });

  test("leaves out what `ignore` matches, never the entry file, and warns of a pattern matching nothing", async () => {
    const { found, warnings } = await exportsOn(
      manifestWith("  - path: skills\n    ignore: [workspace-data/, '*.log', SKILL.md, '*.tmp']\n"),
      base,
    );
    expect(found.get(join(base, "skills", "review"))?.files?.map((file) => file.as)).toEqual([
      "SKILL.md",
      "docs/a.md",
      "docs/b/c.md",
      "workspace/AGENTS.md",
      "workspace/SOUL.md",
    ]);
    // The entry file always goes, so a pattern matching it leaves nothing out either.
    expect(warnings).toEqual([
      'Export "skills" ignores "SKILL.md", which matches no file it publishes, so it leaves nothing out.',
      'Export "skills" ignores "*.tmp", which matches no file it publishes, so it leaves nothing out.',
    ]);
  });

  test("combines every reaching entry's `include` and `ignore`", async () => {
    const files = await filesOf(
      [
        "  - path: skills",
        "    ignore: [docs/b/]",
        "  - path: skills/review",
        "    include: [docs]",
        "  - path: skills/review/SKILL.md",
        "    include: [{ from: workspace/SOUL.md, as: SOUL.md }]",
        "",
      ].join("\n"),
    );
    expect(files).toEqual([
      { from: "SKILL.md", as: "SKILL.md" },
      { from: "workspace/SOUL.md", as: "SOUL.md" },
      { from: "docs/a.md", as: "docs/a.md" },
    ]);
  });

  test("refuses two files stored at one path", async () => {
    await expect(
      filesOf(
        "  - path: skills/review\n    include: [docs/a.md, { from: workspace/SOUL.md, as: docs/a.md }]\n",
      ),
    ).rejects.toThrow("would store two files as docs/a.md.");
    await expect(
      filesOf(
        "  - path: skills/review\n    include: [{ from: workspace/SOUL.md, as: docs/a.md }]\n  - path: skills/review/SKILL.md\n    include: [docs/a.md]\n",
      ),
    ).rejects.toMatchObject({
      message: "skills/review would publish both workspace/SOUL.md and docs/a.md as docs/a.md.",
      code: "invalid",
    });
  });

  test("refuses `include` or `ignore` on an agent's one file", async () => {
    await expect(
      exportsOn(manifestWith("  - path: agents/reviewer.md\n    ignore: ['*.log']\n"), base),
    ).rejects.toThrow(
      'Export "agents/reviewer.md" sets `ignore`, but an agent\'s .md file is one file.',
    );
    // Reached through its folder, the folder's patterns simply have nothing to apply to.
    const { found } = await exportsOn(
      manifestWith("  - path: agents\n    ignore: ['*.log']\n"),
      base,
    );
    expect(found.get(join(base, "agents", "reviewer.md"))?.files).toBe(undefined);
  });

  test("reads `include` against what git tracks", async ({ git }) => {
    await git.init(base);
    await git(base, "add", "skills/review/SKILL.md", "skills/review/docs");
    await expect(
      filesOf("  - path: skills/review\n    include: [workspace/AGENTS.md]\n"),
    ).rejects.toMatchObject({
      hint: "Check the path under `include`, relative to the artifact's folder, and that git tracks it.",
    });
    expect(await filesOf("  - path: skills/review\n    include: [docs/b]\n")).toEqual([
      { from: "SKILL.md", as: "SKILL.md" },
      { from: "docs/b/c.md", as: "docs/b/c.md" },
    ]);
  });
});

/** A skill with more in its folder than its SKILL.md. */
function beforeEachFiles(): void {
  test.beforeEach(async () => {
    const review = join(base, "skills", "review");
    for (const [path, body] of [
      ["workspace/AGENTS.md", "How it works.\n"],
      ["workspace/SOUL.md", "Who it is.\n"],
      ["workspace-data/state.json", "{}\n"],
      ["run.log", "Ran.\n"],
      ["docs/a.md", "A.\n"],
      ["docs/b/c.md", "C.\n"],
    ] as const) {
      await mkdir(join(review, path, ".."), { recursive: true });
      await writeFile(join(review, path), body);
    }
  });
}
