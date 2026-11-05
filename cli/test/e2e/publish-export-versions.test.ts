import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { manifestPath, writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let aireg: Aireg;

test.beforeAll(({ aireg: run }) => {
  aireg = run;
});

describe("an export's own version", () => {
  // A repository whose one export, a skill, fixes its version; it publishes to a folder inside it.
  let repo: string;
  const skill = () => join(repo, ".claude", "skills", "lint", "SKILL.md");
  const versionsAt = () =>
    join(repo, "registry", "artifacts", "eng", "skill", "lint", "versions.json");
  const written = async () =>
    (
      JSON.parse(await readFile(versionsAt(), "utf8")) as { versions: { version: string }[] }
    ).versions
      .map((row) => row.version)
      .sort();
  const fixAt = (version: string | undefined) =>
    writeManifestIn(
      repo,
      `exports:\n  - path: .claude/skills/lint${version === undefined ? "" : `\n    version: ${version}`}\npublish:\n  to: ./registry/eng\n`,
    );

  const mark = async (version: string, status: string, reason?: string) => {
    const document = JSON.parse(await readFile(versionsAt(), "utf8")) as {
      versions: { version: string; status?: string; reason?: string }[];
    };
    for (const row of document.versions) {
      if (row.version !== version) continue;
      row.status = status;
      if (reason !== undefined) row.reason = reason;
    }
    await writeFile(versionsAt(), JSON.stringify(document, null, 2));
  };
  const send = (...args: string[]) => aireg(["publish", "-y", ...args], { cwd: repo });

  test.beforeAll(async ({ tmp, git }) => {
    repo = join(tmp, "fixed");
    await git.init(repo);
    await mkdir(join(repo, ".claude", "skills", "lint"), { recursive: true });
    await writeFile(skill(), skillBody("lint", "Lints a change."));
    await fixAt("0.2.0");
    const made = await aireg(["registry", "init", "registry", "--name", "fixed", "-y"], {
      cwd: repo,
    });
    expect(made.code, made.stderr).toBe(0);
    const first = await send();
    expect(first.code, first.stderr).toBe(0);
    expect(await written()).toEqual(["0.2.0"]);
  });

  test("is the same when a draft holds it with these files, every run", async () => {
    await mark("0.2.0", "draft");
    for (const _ of [1, 2]) {
      const again = await send();
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/same {4}eng\/skill\/lint {2}0\.2\.0, already published/);
    }
    expect(await written()).toEqual(["0.2.0"]);
  });

  test("is refused when a blocked version holds it, writing no other version, every run", async () => {
    await mark("0.2.0", "blocked", "leaks tokens");
    await appendFile(skill(), "Check the imports.\n");
    for (const _ of [1, 2]) {
      const refused = await send("--json");
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout).error).toMatchObject({
        code: "conflict",
        message: "eng/lint@0.2.0 is already published, and is blocked (leaks tokens).",
      });
    }
    expect(await written()).toEqual(["0.2.0"]);
  });

  test("goes past a blocked newest version once it fixes none, and says which", async () => {
    await fixAt(undefined);
    const sent = await send("--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).data.artifacts).toEqual([
      expect.objectContaining({ from: "0.2.0", version: "0.2.1", published: true }),
    ]);
    expect(await written()).toEqual(["0.2.0", "0.2.1"]);
  });

  test("says when the version it fixes is below the newest", async () => {
    await fixAt("0.1.5");
    const shown = await send("--dry-run");
    expect(shown.stdout).toMatch(
      /update {2}eng\/skill\/lint {2}0\.2\.1 → 0\.1\.5 \(below latest\)/,
    );
    const sent = await send("--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).data.artifacts).toEqual([
      expect.objectContaining({ from: "0.2.1", version: "0.1.5", belowLatest: true }),
    ]);
    expect(await written()).toEqual(["0.1.5", "0.2.0", "0.2.1"]);
  });

  test("goes past a yanked newest version, though latest moved below it", async () => {
    await fixAt(undefined);
    await appendFile(skill(), "Check the exports.\n");
    expect((await send()).code).toBe(0);
    const document = JSON.parse(await readFile(versionsAt(), "utf8")) as {
      versions: { version: string; yanked?: boolean }[];
    };
    for (const row of document.versions) if (row.version === "0.2.2") row.yanked = true;
    await writeFile(versionsAt(), JSON.stringify(document, null, 2));
    expect((await aireg(["registry", "index"], { cwd: join(repo, "registry") })).code).toBe(0);
    expect(JSON.parse(await readFile(versionsAt(), "utf8")).latest).toBe("0.2.1");

    await appendFile(skill(), "Check the re-exports.\n");
    const sent = await send("--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).data.artifacts).toEqual([
      expect.objectContaining({ from: "0.2.1", version: "0.2.3", published: true }),
    ]);
    expect(await written()).toEqual(["0.1.5", "0.2.0", "0.2.1", "0.2.2", "0.2.3"]);
  });
});

describe("a dependent whose export fixes its version", () => {
  let repo: string;
  const send = (...args: string[]) => aireg(["publish", "-y", ...args], { cwd: repo });

  test.beforeAll(async ({ tmp, git }) => {
    repo = join(tmp, "pinned");
    await git.init(repo);
    await mkdir(join(repo, ".claude", "skills", "review"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "skills", "review", "SKILL.md"),
      skillBody("review", "The review checklist."),
    );
    await mkdir(join(repo, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews a pull request.\n---\nReview it.\n",
    );
    await writeManifestIn(
      repo,
      `exports:
  - .claude/skills/review
  - path: .claude/agents/reviewer.md
    version: 0.0.5
    depends_on:
      - ./.claude/skills/review
publish:
  to: ./registry/eng
`,
    );
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "exports");
    const made = await aireg(["registry", "init", "registry", "--name", "pinned", "-y"], {
      cwd: repo,
    });
    expect(made.code, made.stderr).toBe(0);
    const first = await send();
    expect(first.code, first.stderr).toBe(0);
  });

  test("refuses a dependency's changed label until the dependent gets its own new version", async () => {
    await appendFile(join(repo, ".claude", "skills", "review", "SKILL.md"), "Check tests.\n");
    const refused = await send();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("eng/reviewer@0.0.5 is already published.");
    const text = await readFile(manifestPath(repo), "utf8");
    await writeFile(manifestPath(repo), text.replace("version: 0.0.5", "version: 0.0.6"));
    const sent = await send("--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).data.artifacts).toEqual([
      expect.objectContaining({ name: "review", version: "0.1.1", published: true }),
      expect.objectContaining({
        name: "reviewer",
        version: "0.0.6",
        published: true,
        dependsOn: [{ to: "eng/skill/review@0.1.1" }],
      }),
    ]);
  });
});
