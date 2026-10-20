import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

// A repository lists what it makes under `exports:` and where it goes under `publish.to`, so a bare
// `aireg publish` sends each export in dependency order, writing its `depends_on` as registry edges.
// Another project then installs the agent from that registry and gets the skill it depends on.

let aireg: Aireg;
/** The repository that makes the skill and the agent, with its registry folder inside it. */
let maker: string;
/** Another project, which installs from that registry folder. */
let project: string;

const EXPORTS = `exports:
  - .claude/skills/*
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review
`;

const envelope = async (kind: string, name: string, version: string) =>
  JSON.parse(
    await readFile(
      join(maker, "registry", "artifacts", "eng", kind, name, version, "artifact.json"),
      "utf8",
    ),
  );

const publish = (...args: string[]) => aireg(["publish", ...args], { cwd: maker });

test.beforeAll(async ({ aireg: run, tmp, project: dir, git }) => {
  [aireg, maker, project] = [run, join(tmp, "maker"), dir];
  await git.init(maker);
  for (const name of ["review", "scratch"]) {
    await mkdir(join(maker, ".claude", "skills", name), { recursive: true });
    await writeFile(
      join(maker, ".claude", "skills", name, "SKILL.md"),
      skillBody(name, `The ${name} checklist.`),
    );
  }
  await mkdir(join(maker, ".claude", "agents"), { recursive: true });
  await writeFile(
    join(maker, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews a pull request.\n---\nReview it.\n",
  );
  await writeManifestIn(maker, `${EXPORTS}publish:\n  to: [./registry/eng]\n`);
  // The scratch skill is never committed, so the glob leaves it out.
  await git(maker, "add", ".claude/skills/review", ".claude/agents", ".registry");
  await git(maker, "commit", "-qm", "exports");
  const made = await aireg(["registry", "init", "registry", "--name", "maker", "-y"], {
    cwd: maker,
  });
  expect(made.code, made.stderr).toBe(0);
}, 60_000);

describe("publishing a repository's exports", () => {
  test("plans each tracked export, after what it depends on, under --dry-run", async () => {
    const shown = await publish("--dry-run");
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(
      /add {5}eng\/skill\/review {2}0\.1\.0\n {2}add {5}eng\/agent\/reviewer {2}0\.1\.0, depends on review \^0\.1\.0/,
    );
    expect(shown.stdout).not.toContain("scratch");

    const json = await publish("--dry-run", "--json");
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual({
      dryRun: true,
      artifacts: [
        expect.objectContaining({ name: "review", version: "0.1.0", dependsOn: [] }),
        expect.objectContaining({
          name: "reviewer",
          kind: "agent",
          registry: "./registry",
          namespace: "eng",
          version: "0.1.0",
          published: false,
          dependsOn: [{ to: "eng/skill/review@0.1.0", range: "^0.1.0" }],
        }),
      ],
      skipped: [],
    });
  });

  test("publishes them with the edge, and nothing again when nothing changed", async () => {
    const sent = await publish("-y");
    expect(sent.code, sent.stderr).toBe(0);
    expect((await envelope("agent", "reviewer", "0.1.0")).relationships).toEqual([
      { rel_type: "depends_on", to: "eng/skill/review@0.1.0", range: "^0.1.0" },
    ]);
    const valid = await aireg(["registry", "validate"], { cwd: join(maker, "registry") });
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
    expect((await publish("-y")).stdout).toMatch(/Nothing new to publish/);
  });

  test("moves a dependent whose dependency moved, since its edge did", async () => {
    await appendFile(join(maker, ".claude", "skills", "review", "SKILL.md"), "Check tests.\n");
    const sent = await publish("-y");
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update {2}eng\/skill\/review {2}0\.1\.0 → 0\.1\.1/);
    expect(sent.stdout).toMatch(
      /update {2}eng\/agent\/reviewer {2}0\.1\.0 → 0\.1\.1, depends on review \^0\.1\.1/,
    );
  });

  test("installs the agent elsewhere with the skill it depends on", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    expect((await aireg(["init", "-y"])).code).toBe(0);
    const declared = await aireg(["registry", "add", join(maker, "registry"), "--as", "maker"]);
    expect(declared.code, declared.stderr).toBe(0);
    const added = await aireg(["add", "maker/eng/agent/reviewer@^0.1", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(
      await readFile(join(project, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Check tests.");
    const rows = (
      parse(await readFile(lockPath(project), "utf8")) as {
        artifacts: Record<string, { version?: string; needed_by?: string[]; depends_on?: object }>;
      }
    ).artifacts;
    expect(rows.reviewer).toMatchObject({ version: "0.1.1", depends_on: { review: "^0.1.1" } });
    expect(rows.review).toMatchObject({ version: "0.1.1", needed_by: ["reviewer"] });
  }, 60_000);
});

describe("choosing a target", () => {
  const targets = "publish:\n  to: [./registry/eng, ./registry/ops]\n";

  test("needs --to among several, and only one the manifest lists", async () => {
    await writeManifestIn(maker, `${EXPORTS}${targets}`);
    const unnamed = await publish("-y");
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toContain(
      "The manifest lists 2 publish targets; pass --to ./registry/eng or --to ./registry/ops.",
    );
    const other = await publish("--to", "./registry/other", "-y");
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      '--to "./registry/other" is not one of the manifest\'s publish targets.',
    );
  });

  test("leaves out an export whose own targets do not include it, and says so", async () => {
    await writeManifestIn(maker, `${EXPORTS}    publish:\n      to: [./registry/eng]\n${targets}`);
    const sent = await publish("--to", "./registry/ops", "-y", "--json");
    expect(sent.code, sent.stderr).toBe(0);
    const { data } = JSON.parse(sent.stdout);
    expect(data.artifacts.map((each: { name: string }) => each.name)).toEqual(["review"]);
    expect(data.skipped).toEqual([
      { name: "reviewer", kind: "agent", reason: "its publish.to does not list ./registry/ops" },
    ]);
  });

  test("refuses an export whose dependency is not published to the target", async () => {
    await writeManifestIn(
      maker,
      `exports:
  - path: .claude/skills/review
    publish:
      to: [./registry/eng]
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review
publish:
  to: [./registry/eng, ./registry/qa]
`,
    );
    const sent = await publish("--to", "./registry/qa", "-y");
    expect(sent.code).toBe(1);
    expect(sent.stderr).toContain(
      "reviewer depends on review, which is not published to ./registry/qa.",
    );
    expect(sent.stderr).toContain(
      'Add ./registry/qa to the `publish.to` of export ".claude/skills/review"',
    );
  });
});

describe("an export's own version", () => {
  /** A repository whose one export, a skill, fixes its version, publishing into its own registry folder. */
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
      `exports:\n  - path: .claude/skills/lint${version === undefined ? "" : `\n    version: ${version}`}\npublish:\n  to: [./registry/eng]\n`,
    );
  /** Sets a version's status in `versions.json`, as a registry's maintainers do. */
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
  }, 60_000);

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
  to: [./registry/eng]
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
  }, 60_000);

  test("stays the same when its dependency's next release is still in its range", async () => {
    await appendFile(join(repo, ".claude", "skills", "review", "SKILL.md"), "Check tests.\n");
    const sent = await send("--json");
    expect(sent.code, sent.stderr).toBe(0);
    expect(JSON.parse(sent.stdout).data.artifacts).toEqual([
      expect.objectContaining({ name: "review", from: "0.1.0", version: "0.1.1", published: true }),
      expect.objectContaining({
        name: "reviewer",
        version: "0.0.5",
        published: false,
        dependsOn: [{ to: "eng/skill/review@0.1.0", range: "^0.1.0" }],
      }),
    ]);
    const shown = await send("--dry-run");
    expect(shown.stdout).toMatch(
      /same {4}eng\/agent\/reviewer {2}0\.0\.5, already published, depends on review \^0\.1\.0/,
    );
  });

  test("is refused once its dependency moves past the range it was published with", async () => {
    await writeFile(
      join(repo, ".claude", "skills", "review", "SKILL.md"),
      skillBody("review", "The review checklist.", "Rewritten.\n"),
    );
    const sent = await send("--bump", "minor");
    expect(sent.code).toBe(1);
    expect(sent.stderr).toContain("eng/reviewer@0.0.5 is already published.");
  });
});
