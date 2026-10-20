import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";
import { lockPath } from "#test/kit/scope.ts";

// A repository installed as a folder of skills may be a project whose manifest exports some of
// them. An export's `depends_on` then installs with it: another export of the same source, and
// an artifact the project installs, from the registry this project declares at its address.

const SHARED = "https://github.com/acme/shared";

/** `reviewer`, exported needing the source's `review` and `shared`'s `sql-style` within ^1.2. */
const MANIFEST = `registries:
  shared: github.com/acme/shared
artifacts:
  - shared/platform/skill/sql-style@^1.2
exports:
  - .claude/skills/*
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review
      - shared/platform/skill/sql-style
publish:
  to: [shared/engineering]
`;

function tools(root: string, manifest = MANIFEST) {
  return skillsFolder(root)
    .agent(".claude/agents/reviewer.md", { body: "Review with the review skill.\n" })
    .skill(".claude/skills/review", { body: "Review it.\n" })
    .skill(".claude/skills/notes")
    .file(".registry/manifest.yml", manifest);
}

/** `sql-style` at 1.2.0, 1.3.0 and 2.0.0, in a folder whose registry.json names `SHARED`. */
async function platform(root: string): Promise<string> {
  const built = registry(root, { name: "platform", slug: "platform", url: SHARED });
  for (const version of ["1.2.0", "1.3.0", "2.0.0"]) {
    built.skill(`platform/sql-style@${version}`, { body: `style ${version}\n` });
  }
  return built.write();
}

interface Row {
  registry?: string;
  version?: string;
  needed_by?: string[];
  depends_on?: Record<string, string>;
}

const rows = async (project: string) =>
  (parse(await readFile(lockPath(project), "utf8")) as { artifacts: Record<string, Row> })
    .artifacts;

const read = (project: string, ...path: string[]) =>
  readFile(join(project, ".claude", ...path), "utf8");

const init = async (aireg: Aireg) =>
  expect((await aireg(["init", "--for", "claude"])).code).toBe(0);

describe("a source whose manifest exports what it holds", () => {
  test("installs an export with the sibling and the registry artifact it depends on", async ({
    aireg,
    project,
    tmp,
  }) => {
    const source = await tools(join(tmp, "tools")).write();
    await init(aireg);
    expect((await aireg(["registry", "add", await platform(join(tmp, "platform"))])).code).toBe(0);

    const added = await aireg(["add", source, "-s", "reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(await read(project, "agents", "reviewer.md")).toContain("Review with the review skill.");
    expect(await read(project, "skills", "review", "SKILL.md")).toContain("Review it.");
    expect(await read(project, "skills", "sql-style", "SKILL.md")).toContain("style 1.3.0");
    const locked = await rows(project);
    expect(Object.keys(locked).sort()).toEqual(["review", "reviewer", "sql-style"]);
    expect(locked.reviewer).toMatchObject({
      registry: "tools",
      depends_on: { "sql-style": "^1.2" },
    });
    expect(locked.review).toMatchObject({ registry: "tools", needed_by: ["reviewer"] });
    expect(locked["sql-style"]).toMatchObject({
      registry: "platform",
      version: "1.3.0",
      needed_by: ["reviewer"],
    });

    // Planned from the lockfile alone, the sibling with no version is still needed.
    const before = await readFile(lockPath(project), "utf8");
    const frozen = await aireg(["install", "--frozen", "-y"]);
    expect(frozen.code, frozen.stderr).toBe(0);
    expect(await readFile(lockPath(project), "utf8")).toBe(before);
  }, 60_000);

  test("fails when this project does not declare the registry an export's dependency is in", async ({
    aireg,
    project,
    tmp,
  }) => {
    const source = await tools(join(tmp, "tools")).write();
    await init(aireg);
    const added = await aireg(["add", source, "-s", "reviewer", "-y"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain(
      `tools/agent/reviewer needs platform/skill/sql-style from ${SHARED}, which this project does not declare.`,
    );
    expect(added.stderr).toContain(`Run \`aireg registry add ${SHARED}\` to allow it.`);
    expect(await readFile(lockPath(project), "utf8").catch(() => "")).not.toContain("reviewer");
  }, 60_000);

  test("installs what it names, with a warning, when the source's manifest does not read", async ({
    aireg,
    project,
    tmp,
  }) => {
    const source = await tools(join(tmp, "tools"), "exports: [\n").write();
    await init(aireg);
    const added = await aireg(["add", source, "-s", "reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain("Ignored .registry/manifest.yml, which aireg cannot read (");
    expect(added.stderr).toContain("so what it exports installs without its dependencies.");
    expect(Object.keys(await rows(project))).toEqual(["reviewer"]);
  }, 60_000);

  test("reads a git repository's exports at one commit, and moves them together", async ({
    aireg,
    git,
    project,
    tmp,
  }) => {
    // Only the sibling: no registry artifact, so nothing else need be declared.
    const local = MANIFEST.replace("      - shared/platform/skill/sql-style\n", "");
    const repo = await tools(join(tmp, "tools"), local).write();
    await git.init(repo);
    await git.commit(repo, "one");
    await init(aireg);

    const added = await aireg(["add", pathToFileURL(repo).href, "-s", "reviewer", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect((await rows(project)).review).toMatchObject({ needed_by: ["reviewer"] });

    // Updating the dependency alone moves the whole source, its dependent with it.
    await skillsFolder(repo).skill(".claude/skills/review", { body: "Review it twice.\n" }).write();
    await git.commit(repo, "two");
    const updated = await aireg(["update", "review", "-y"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stderr).not.toContain("stays at");
    expect(await read(project, "skills", "review", "SKILL.md")).toContain("Review it twice.");

    await skillsFolder(repo)
      .agent(".claude/agents/reviewer.md", { body: "Review twice.\n" })
      .write();
    await git.commit(repo, "three");
    expect((await aireg(["update", "-y"])).code).toBe(0);
    expect(await read(project, "agents", "reviewer.md")).toContain("Review twice.");
    expect((await rows(project)).review).toMatchObject({ needed_by: ["reviewer"] });
  }, 60_000);
});
