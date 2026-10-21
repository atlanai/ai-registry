import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { lockPath, manifestPath, writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let aireg: Aireg;
/** The repository that makes the skill and the agent, with its registry folder inside it. */
let maker: string;
/** Another project, which installs from that registry folder. */
let project: string;

const EXPORTS = `exports:
  - .claude/skills
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
  // A README beside the skills is no agent, so the glob skips it.
  await writeFile(join(maker, ".claude", "skills", "README.md"), "# Our skills\n");
  await writeManifestIn(maker, `${EXPORTS}publish:\n  to: ./registry/eng\n`);
  // The scratch skill is never committed, so the glob leaves it out.
  await git(maker, "add", ".claude/skills/review", ".claude/skills/README.md", ".claude/agents");
  await git(maker, "add", ".registry");
  await git(maker, "commit", "-qm", "exports");
  // Nor is a note written in the review skill since, so its folder is published without it.
  await writeFile(join(maker, ".claude", "skills", "review", "draft.md"), "Not yet.\n");
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
      /add {5}eng\/skill\/review {2}0\.1\.0\n {2}add {5}eng\/agent\/reviewer {2}0\.1\.0, depends on review 0\.1\.0/,
    );
    expect(shown.stdout).not.toContain("scratch");
    expect(shown.stdout).toContain(
      "Skipped .claude/skills/README.md, which has no name and description in its front matter, so it is no agent.",
    );

    const json = await publish("--dry-run", "--json");
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual({
      dryRun: true,
      target: { registry: "./registry", namespace: "eng" },
      artifacts: [
        expect.objectContaining({ name: "review", version: "0.1.0", dependsOn: [] }),
        expect.objectContaining({
          name: "reviewer",
          kind: "agent",
          registry: "./registry",
          namespace: "eng",
          version: "0.1.0",
          published: false,
          dependsOn: [{ to: "eng/skill/review@0.1.0" }],
        }),
      ],
      skipped: [],
    });
  });

  test("publishes them with the edge, and nothing again when nothing changed", async () => {
    const sent = await publish("-y");
    expect(sent.code, sent.stderr).toBe(0);
    expect((await envelope("agent", "reviewer", "0.1.0")).relationships).toEqual([
      { rel_type: "depends_on", to: "eng/skill/review@0.1.0" },
    ]);
    const files = (await envelope("skill", "review", "0.1.0")).files as { path: string }[];
    expect(files.map((file) => file.path)).toEqual(["SKILL.md"]);
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
      /update {2}eng\/agent\/reviewer {2}0\.1\.0 → 0\.1\.1, depends on review 0\.1\.1/,
    );
  });

  test("installs the agent elsewhere with the skill it depends on", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    expect((await aireg(["init", "-y"])).code).toBe(0);
    const declared = await aireg(["registry", "add", join(maker, "registry"), "--as", "maker"]);
    expect(declared.code, declared.stderr).toBe(0);
    const added = await aireg(["add", "maker/eng/agent/reviewer@0.1.1", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(
      await readFile(join(project, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Check tests.");
    const rows = (
      parse(await readFile(lockPath(project), "utf8")) as {
        artifacts: Record<string, { version?: string; needed_by?: string[]; depends_on?: object }>;
      }
    ).artifacts;
    expect(rows.reviewer).toMatchObject({ version: "0.1.1" });
    expect(rows.review).toMatchObject({ version: "0.1.1", needed_by: ["reviewer"] });
  }, 60_000);
});

describe("the publish target", () => {
  test("is the manifest's one target, which --to may only repeat", async () => {
    await writeManifestIn(maker, `${EXPORTS}publish:\n  to: ./registry/eng\n`);
    const same = await publish("--to", "./registry/eng", "--dry-run");
    expect(same.code, same.stderr).toBe(0);
    const other = await publish("--to", "./registry/ops", "-y");
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      '--to "./registry/ops" is not the manifest\'s publish target, ./registry/eng.',
    );
    expect(other.stderr).toContain(
      "Leave `--to` off to publish to ./registry/eng, or change `publish.to`.",
    );
  });

  test("refuses a list of targets, naming one to keep", async () => {
    await writeManifestIn(maker, `${EXPORTS}publish:\n  to: [./registry/eng, ./registry/ops]\n`);
    const listed = await publish("-y");
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain("`publish.to` names one target, not a list.");
    expect(listed.stderr).toContain(
      "Keep the one this project publishes to, such as `to: ./registry/eng`.",
    );
  });

  test("leaves out an export that sets publish: false, and refuses one depending on it", async () => {
    await writeManifestIn(
      maker,
      `exports:
  - path: .claude/skills/review
    publish: false
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review
publish:
  to: ./registry/qa
`,
    );
    const sent = await publish("-y");
    expect(sent.code).toBe(1);
    expect(sent.stderr).toContain(
      '.claude/agents/reviewer.md depends on .claude/skills/review, which export ".claude/skills/review" keeps here with `publish: false`.',
    );
    expect(sent.stderr).toContain(
      'Remove `publish: false` from export ".claude/skills/review", or leave ./.claude/skills/review out of the `depends_on` of export ".claude/agents/reviewer.md".',
    );
    await writeManifestIn(
      maker,
      "exports:\n  - path: .claude/skills/review\n    publish: false\npublish:\n  to: ./registry/qa\n",
    );
    const named = await publish(".claude/skills/review", "--dry-run", "--json");
    expect(named.code, named.stderr).toBe(0);
    expect(JSON.parse(named.stdout).data.skipped).toEqual([
      {
        name: "review",
        kind: "skill",
        path: ".claude/skills/review",
        reason: "its export sets publish: false",
      },
    ]);
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
  }, 60_000);

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

describe("removing an artifact an export depends on", () => {
  let repo: string;
  const run = (...args: string[]) => aireg(args, { cwd: repo });
  const manifest = () => readFile(manifestPath(repo), "utf8");
  const DEPENDS = "    depends_on:\n      - acme/acme/skill/lint\n";

  test.beforeAll(async ({ tmp }) => {
    repo = join(tmp, "depending");
    const market = await registry(join(tmp, "lint-market"), { name: "acme", slug: "acme" })
      .skill("acme/lint@1.0.0")
      .write();
    await mkdir(join(repo, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews a pull request.\n---\nReview it.\n",
    );
    expect((await run("init", "-y")).code).toBe(0);
    expect((await run("registry", "add", market, "--as", "acme")).code).toBe(0);
    const added = await run("add", "acme/acme/skill/lint", "-y");
    expect(added.code, added.stderr).toBe(0);
    await appendFile(
      manifestPath(repo),
      `exports:\n  - path: .claude/agents/reviewer.md\n${DEPENDS}`,
    );
  }, 60_000);

  test("is refused before anything is written, naming the export", async () => {
    const before = await manifest();
    for (const args of [["lint"], ["--all"]]) {
      const removed = await run("remove", ...args, "-y");
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain(
        'depends on "acme/acme/skill/lint", which is not listed under `artifacts:`.',
      );
    }
    expect(await manifest()).toBe(before);
    expect((await run("list")).stdout).toMatch(/ lint\s+skill/);
  });

  test("goes ahead once the export no longer depends on it", async () => {
    await writeFile(manifestPath(repo), (await manifest()).replace(DEPENDS, ""));
    const removed = await run("remove", "lint", "-y");
    expect(removed.code, removed.stderr).toBe(0);
    expect(await manifest()).not.toContain("acme/acme/skill/lint");
  });
});
